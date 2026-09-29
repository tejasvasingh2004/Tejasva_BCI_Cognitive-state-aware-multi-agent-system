import type { Pool } from '@neuroflow/db';
import { RunControlListener, type Redis } from '@neuroflow/bus';
import { BciHttpProvider, ChainedProvider, StoredStateProvider, type CognitiveStateProvider } from '@neuroflow/cognitive';
import { cognitiveRepo, executionRepo, runsRepo } from '@neuroflow/db';
import { createMemoryTools, PgMemoryService } from '@neuroflow/memory';
import type { ModelGateway } from '@neuroflow/models';
import { Orchestrator, type RunStore } from '@neuroflow/orchestrator';
import { builtinTools, ToolRegistry, ToolRuntime, type ToolCallRecorder } from '@neuroflow/tools';

export type WorkerRuntime = {
  orchestrator: Orchestrator;
  control: RunControlListener;
};

export type RuntimeOptions = {
  pool: Pool;
  redis: Redis;
  controlSubscriber: Redis;
  gateway: ModelGateway;
  bciServiceUrl?: string;
  approvalTimeoutMs?: number;
};

/** Wires the orchestrator to PostgreSQL, Redis and the configured providers. */
export async function createWorkerRuntime(opts: RuntimeOptions): Promise<WorkerRuntime> {
  const { pool } = opts;
  const control = new RunControlListener(opts.controlSubscriber, opts.redis);
  await control.start();

  const registry = new ToolRegistry().registerAll([...builtinTools, ...createMemoryTools(new PgMemoryService(pool))]);

  const recorder: ToolCallRecorder = {
    start: (i) => executionRepo.startToolCall(pool, i),
    approval: (runId, id, status) => executionRepo.setToolApproval(pool, runId, id, status),
    finish: (runId, result) => executionRepo.finishToolCall(pool, runId, result),
    findCompleted: (runId, id) => executionRepo.findCompletedToolCall(pool, runId, id),
  };
  const tools = new ToolRuntime(registry, {
    recorder,
    approvalTimeoutMs: opts.approvalTimeoutMs,
    approvals: { wait: (runId, id, timeout, signal) => control.waitForApproval(runId, id, timeout, signal) },
  });

  const store: RunStore = {
    setPlan: (runId, plan) => runsRepo.setPlan(pool, runId, plan),
    startAgent: (i) => executionRepo.startAgent(pool, i),
    finishAgent: (id, i) => executionRepo.finishAgent(pool, id, i),
    recordModelCall: (i) => executionRepo.recordModelCall(pool, i),
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
  });
  return { orchestrator, control };
}
