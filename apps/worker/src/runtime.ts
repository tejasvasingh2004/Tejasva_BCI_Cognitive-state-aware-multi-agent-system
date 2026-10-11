import type { Pool } from '@neuroflow/db';
import { RunControlListener, UsageMeter, type Redis } from '@neuroflow/bus';
import { BciHttpProvider, ChainedProvider, StoredStateProvider, type CognitiveStateProvider } from '@neuroflow/cognitive';
import { agentsRepo, cognitiveRepo, executionRepo, runsRepo } from '@neuroflow/db';
import { createMemoryTools, PgMemoryService } from '@neuroflow/memory';
import type { ModelGateway } from '@neuroflow/models';
import { agentFromSpec, Orchestrator, type RunStore } from '@neuroflow/orchestrator';
import { CodeWorkspaceService, createCodeTools, defaultCodeDataDir, DockerSandbox, SecretBox, type Sandbox } from '@neuroflow/code';
import {
  builtinTools,
  createWebSearchTool,
  ToolRegistry,
  ToolRuntime,
  webSearchProviderFromEnv,
  type ToolCallRecorder,
} from '@neuroflow/tools';

export type WorkerRuntime = {
  orchestrator: Orchestrator;
  control: RunControlListener;
  gateway: ModelGateway;
  memory: PgMemoryService;
  /** Code workspaces: checkouts, sandbox, git/GitHub operations (Product Phase 2). */
  code: CodeWorkspaceService;
};

export type RuntimeOptions = {
  pool: Pool;
  redis: Redis;
  controlSubscriber: Redis;
  gateway: ModelGateway;
  bciServiceUrl?: string;
  approvalTimeoutMs?: number;
  /** Source of optional integrations (web search provider keys). */
  env?: NodeJS.ProcessEnv;
  code?: { dataDir?: string; secretsKey?: string; sessionSecret?: string; githubApiUrl?: string; sandbox?: Sandbox };
  /** Receives unexpected tool errors (details stay in operator logs, never in model context). */
  onToolError?: (err: unknown, info: { tool: string; phase: 'prepare' | 'execute'; runId: string; toolCallId: string }) => void;
};

/** Wires the orchestrator to PostgreSQL, Redis and the configured providers. */
export async function createWorkerRuntime(opts: RuntimeOptions): Promise<WorkerRuntime> {
  const { pool } = opts;
  const control = new RunControlListener(opts.controlSubscriber, opts.redis);
  await control.start();

  const memory = new PgMemoryService(pool);
  const usage = new UsageMeter(opts.redis);
  const code = new CodeWorkspaceService({
    pool,
    redis: opts.redis,
    dataDir: opts.code?.dataDir ?? defaultCodeDataDir(),
    secrets: SecretBox.fromEnv(opts.code?.secretsKey, opts.code?.sessionSecret ?? 'dev-only-session-secret-change-me-please-0123456789'),
    sandbox: opts.code?.sandbox ?? new DockerSandbox(),
    githubApiUrl: opts.code?.githubApiUrl,
  });
  const registry = new ToolRegistry().registerAll([...builtinTools, ...createMemoryTools(memory), ...createCodeTools(code.toolServices())]);
  const search = webSearchProviderFromEnv(opts.env ?? process.env);
  if (search) registry.register(createWebSearchTool(search));

  const recorder: ToolCallRecorder = {
    start: (i) => executionRepo.startToolCall(pool, i),
    approval: (runId, id, status) => executionRepo.setToolApproval(pool, runId, id, status),
    finish: (runId, result, extra) => executionRepo.finishToolCall(pool, runId, result, extra),
    findCompleted: (runId, id) => executionRepo.findCompletedToolCall(pool, runId, id),
  };
  const tools = new ToolRuntime(registry, {
    recorder,
    approvalTimeoutMs: opts.approvalTimeoutMs,
    approvals: { wait: (runId, id, timeout, signal) => control.waitForApproval(runId, id, timeout, signal) },
    ...(opts.onToolError ? { onUnexpectedError: opts.onToolError } : {}),
  });

  const store: RunStore = {
    setPlan: (runId, plan) => runsRepo.setPlan(pool, runId, plan),
    startAgent: (i) => executionRepo.startAgent(pool, i),
    finishAgent: (id, i) => executionRepo.finishAgent(pool, id, i),
    recordModelCall: async (i) => {
      await executionRepo.recordModelCall(pool, i);
      // Daily token metering per workspace (plan quotas now, billing later).
      if (i.workspaceId && i.usage?.totalTokens) await usage.addTokens(i.workspaceId, i.usage.totalTokens).catch(() => {});
    },
    recordEvaluation: (i) => executionRepo.recordEvaluation(pool, i),
  };

  // A manual self-report (or a recent stored sample) wins; otherwise sample the BCI service live.
  const providers: CognitiveStateProvider[] = [
    new StoredStateProvider({ get: (s) => cognitiveRepo.get(pool, s.workspaceId, s.userId) }),
  ];
  if (opts.bciServiceUrl) providers.push(new BciHttpProvider(opts.bciServiceUrl));

  const orchestrator = new Orchestrator({
    gateway: opts.gateway,
    tools,
    store,
    cognitive: new ChainedProvider(providers),
    loadAgents: async (workspaceId) => (await agentsRepo.listForWorkspace(pool, workspaceId)).map(agentFromSpec),
  });
  return { orchestrator, control, gateway: opts.gateway, memory, code };
}
