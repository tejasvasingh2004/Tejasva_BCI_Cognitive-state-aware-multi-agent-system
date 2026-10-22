import { classifyCommand, runInSandbox } from '@neuroflow/code';
import { publishWorkspaceEvent, type Redis, type WorkspaceJobData } from '@neuroflow/bus';
import type { Logger } from '@neuroflow/observability';
import type { Pool } from '@neuroflow/db';
import { runModelEvaluation } from './model-eval';
import type { WorkerRuntime } from './runtime';

/**
 * Code-workspace background tasks: repository clone/sync and user terminal commands. Commands run
 * only in the sandbox, re-checked against the command policy (the API already checked once).
 */
export async function processWorkspaceJob(
  job: WorkspaceJobData,
  deps: { runtime: WorkerRuntime; redis: Redis; logger: Logger; signal: AbortSignal; pool: Pool },
) {
  const { runtime, redis, logger } = deps;
  if (job.kind === 'model.evaluate') {
    await runModelEvaluation({ pool: deps.pool, gateway: await runtime.gatewayFor(job.workspaceId), logger, signal: deps.signal }, job.evaluationId);
    return;
  }
  const log = logger.child({ codeWorkspaceId: job.codeWorkspaceId, job: job.kind });
  if (job.kind === 'workspace.sync') {
    await runtime.code.sync(job.codeWorkspaceId, job.workspaceId).catch((err) => {
      // Sync failures are recorded on the workspace (status=error); do not retry blindly.
      log.warn({ err }, 'workspace sync failed');
    });
    return;
  }

  const publish = (type: string, data: unknown) => publishWorkspaceEvent(redis, job.codeWorkspaceId, type, data).catch(() => {});
  // Users approve their own commands by running them; the deny list still applies.
  const decision = classifyCommand(job.command, 'auto');
  if (decision.decision === 'deny') {
    await publish('command.denied', { correlationId: job.executionId, command: job.command, reason: decision.reason });
    return;
  }
  const ws = await runtime.code.open(job.codeWorkspaceId, job.workspaceId);
  try {
    await runInSandbox(
      runtime.code.toolServices(),
      {
        runId: '',
        workspaceId: job.workspaceId,
        signal: deps.signal,
        emit: (type, data) => void publish(type, { ...(data as object), correlationId: job.executionId }),
      },
      ws,
      { command: job.command, kind: job.commandKind, network: decision.network, triggeredBy: 'user', runId: null },
    );
  } catch (err) {
    await publish('command.failed', { correlationId: job.executionId, message: err instanceof Error ? err.message : 'Command failed' });
  }
  // File changes made by commands (formatters, generators) show up in the Git panel.
  const { files, additions, deletions } = await runtime.code.diffSummary(job.codeWorkspaceId).catch(() => ({ files: [], additions: 0, deletions: 0 }));
  await publish('git.diff.updated', { files, additions, deletions });
}
