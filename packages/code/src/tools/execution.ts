import { access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Scopes, type SandboxExecution } from '@neuroflow/contracts';
import { defineTool, ToolExecutionError, type Prepared, type ToolContext, type ToolDefinition } from '@neuroflow/tools';
import { classifyCommand, type CommandDecision } from '../policy';
import { SandboxUnavailableError } from '../sandbox';
import { assertModeAllows, openFor, type CodeServices, type OpenCodeWorkspace } from '../services';
import { condenseOutput, parseTestSummary } from '../test-summary';

type Kind = SandboxExecution['kind'];
type ExecState = { command: string; kind: Kind; decision: CommandDecision; ws: OpenCodeWorkspace };

const STREAM_FLUSH_MS = 300;
const STREAM_CHUNK = 4_000;
const STREAM_BUDGET = 200_000;

/**
 * Runs an already-authorised command in the sandbox and records it. Output streams to the UI as
 * `command.output` events (throttled and bounded) and is persisted with the execution.
 */
export async function runInSandbox(
  services: CodeServices,
  ctx: Pick<ToolContext, 'runId' | 'workspaceId' | 'emit' | 'signal'>,
  ws: OpenCodeWorkspace,
  input: { command: string; kind: Kind; network: 'none' | 'bridge'; triggeredBy: 'agent' | 'user'; runId?: string | null },
) {
  if (!(await services.sandbox.available())) {
    throw new ToolExecutionError('The command sandbox (Docker) is not available. Commands are never run outside the sandbox.', true);
  }
  const { profile } = await ws.checkout.understand();
  const runId = input.runId === undefined ? ctx.runId : input.runId;
  const executionId = await services.store.startExecution({
    workspaceId: ctx.workspaceId,
    codeWorkspaceId: ws.id,
    runId,
    kind: input.kind,
    command: input.command,
    image: ws.sandboxImage ?? profile.image,
    network: input.network,
    triggeredBy: input.triggeredBy,
  });
  ctx.emit('command.started', { executionId, command: input.command, kind: input.kind });
  if (input.kind === 'test') ctx.emit('test.started', { executionId, command: input.command });

  let pending = '';
  let streamed = 0;
  const flush = () => {
    if (!pending) return;
    if (streamed < STREAM_BUDGET) {
      ctx.emit('command.output', { executionId, chunk: pending.slice(0, STREAM_BUDGET - streamed) });
      streamed += pending.length;
    }
    pending = '';
  };
  const timer = setInterval(flush, STREAM_FLUSH_MS);

  let result;
  try {
    result = await services.sandbox.run({
      workspacePath: ws.checkout.root,
      cachePath: ws.checkout.cacheDir,
      command: input.command,
      image: ws.sandboxImage ?? profile.image,
      network: input.network,
      signal: ctx.signal,
      onOutput: (chunk) => {
        pending += chunk;
        if (pending.length >= STREAM_CHUNK) flush();
      },
    });
  } catch (err) {
    clearInterval(timer);
    flush();
    await services.store.finishExecution(executionId, { status: 'failed', exitCode: null, output: String((err as Error).message), truncated: false, durationMs: 0 });
    if (err instanceof SandboxUnavailableError) throw new ToolExecutionError(err.message, true);
    throw err;
  }
  clearInterval(timer);
  flush();

  const status: SandboxExecution['status'] = result.cancelled ? 'cancelled' : result.timedOut ? 'timeout' : result.exitCode === 0 ? 'passed' : 'failed';
  await services.store.finishExecution(executionId, {
    status,
    exitCode: result.exitCode,
    output: result.output,
    truncated: result.truncated,
    durationMs: result.durationMs,
  });
  ctx.emit('command.completed', {
    executionId,
    kind: input.kind,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  });

  let summary: ReturnType<typeof parseTestSummary> | undefined;
  if (input.kind === 'test') {
    summary = parseTestSummary(result.output);
    const passed = status === 'passed';
    await services.store.recordTest({ executionId, runId, passed, passedCount: summary.passed, failedCount: summary.failed, total: summary.total });
    ctx.emit('test.completed', {
      executionId,
      passed,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(Object.keys(summary).length ? { summary } : {}),
    });
    if (runId) await services.store.updateCodeRun(runId, { testsPassed: passed }).catch(() => {});
  }
  return { executionId, status, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, output: result.output, summary };
}

async function nodeModulesMissing(ws: OpenCodeWorkspace): Promise<boolean> {
  const { profile } = await ws.checkout.understand();
  if (profile.kind !== 'node' || profile.dependencies.length === 0) return false;
  return access(path.join(ws.checkout.root, 'node_modules')).then(
    () => false,
    () => true,
  );
}

export function executionTools(services: CodeServices): ToolDefinition[] {
  const tool = (name: string, kind: Kind, description: string, input: z.ZodObject, pick: (args: Record<string, unknown>, ws: OpenCodeWorkspace) => Promise<string>) =>
    defineTool({
      name,
      description,
      input,
      riskLevel: kind === 'command' ? 'high' : 'medium',
      requiresApproval: false,
      sideEffects: true,
      permissions: [Scopes.codeWrite],
      // Covers dependency installs plus the command itself (the sandbox enforces its own limit).
      timeoutMs: 20 * 60_000,
      maxResultChars: 9_000,
      async prepare(args, ctx): Promise<Prepared<ExecState>> {
        const { ws, mode } = await openFor(services, ctx);
        assertModeAllows(mode, 'execute');
        let command = await pick(args as Record<string, unknown>, ws);
        // A Node project without installed dependencies cannot run tests/lint/build: install first.
        const { profile } = await ws.checkout.understand();
        const install = ws.commands.install ?? profile.commands.install;
        if (kind !== 'command' && install && (await nodeModulesMissing(ws))) command = `${install} && ${command}`;
        const decision = classifyCommand(command, mode);
        if (decision.decision === 'deny') {
          await services.store.denyExecution({
            workspaceId: ctx.workspaceId,
            codeWorkspaceId: ws.id,
            runId: ctx.runId,
            kind,
            command,
            reason: decision.reason,
            triggeredBy: 'agent',
          });
          throw new ToolExecutionError(`Command not allowed (${decision.reason}): ${command}`);
        }
        const state = { command, kind, decision, ws };
        if (decision.decision === 'approval') {
          return { approval: { reason: `${decision.reason}${decision.network === 'bridge' ? ' — runs with network access' : ''}`, preview: { command, network: decision.network } }, state };
        }
        return { state };
      },
      async execute(_args, ctx, prepared) {
        const s = prepared?.state as ExecState | undefined;
        if (!s) throw new ToolExecutionError('Command was not prepared');
        const res = await runInSandbox(services, ctx, s.ws, { command: s.command, kind: s.kind, network: s.decision.network, triggeredBy: 'agent' });
        return {
          command: s.command,
          exitCode: res.exitCode,
          passed: res.status === 'passed',
          ...(res.timedOut ? { timedOut: true } : {}),
          ...(res.summary && Object.keys(res.summary).length ? { tests: res.summary } : {}),
          durationMs: res.durationMs,
          output: condenseOutput(res.output),
        };
      },
      summarize: (o: { exitCode: number; passed: boolean; tests?: { passed?: number; failed?: number } }) =>
        o.tests && o.tests.failed !== undefined
          ? `${o.tests.passed ?? 0} passed, ${o.tests.failed} failed`
          : o.passed
            ? 'Succeeded'
            : `Failed (exit ${o.exitCode})`,
    }) as ToolDefinition;

  const detected = (key: 'test' | 'lint' | 'build', label: string) => async (args: Record<string, unknown>, ws: OpenCodeWorkspace) => {
    if (typeof args.command === 'string' && args.command.trim()) return args.command.trim();
    const { profile } = await ws.checkout.understand();
    const cmd = ws.commands[key] ?? profile.commands[key];
    if (!cmd) throw new ToolExecutionError(`No ${label} command was detected for this repository. Pass one explicitly in "command".`);
    const filter = typeof args.filter === 'string' && args.filter.trim() ? ` ${args.filter.trim().replace(/[;&|`$]/g, '')}` : '';
    return `${cmd}${filter}`;
  };

  return [
    tool(
      'run_command',
      'command',
      'Run a shell command in the isolated sandbox (repository mounted at /workspace, no network, bounded CPU/memory/time). Known dev commands run directly; anything else needs the user\'s approval; dangerous commands are refused.',
      z.object({ command: z.string().min(1).max(2000) }),
      async (args) => String(args.command).trim(),
    ),
    tool(
      'run_tests',
      'test',
      'Run the repository test suite (auto-detected) or a given test command. Use `filter` to pass a test name/path to the runner.',
      z.object({ command: z.string().max(2000).optional(), filter: z.string().max(300).optional() }),
      detected('test', 'test'),
    ),
    tool('run_linter', 'lint', 'Run the linter / type checker (auto-detected) or a given lint command.', z.object({ command: z.string().max(2000).optional() }), detected('lint', 'lint')),
    tool('run_build', 'build', 'Run the build (auto-detected) or a given build command.', z.object({ command: z.string().max(2000).optional() }), detected('build', 'build')),
  ];
}
