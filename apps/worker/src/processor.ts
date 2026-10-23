import type { Pool } from '@neuroflow/db';
import type { ChatMessage } from '@neuroflow/contracts';
import { RunEventEmitter, type RunJobData, type Redis } from '@neuroflow/bus';
import { conversationsRepo, messagesRepo, runEventsRepo, runsRepo, workspaceRepo } from '@neuroflow/db';
import { runtimeMetrics, withExtractedContext, withSpan, type ErrorReporter, type Logger } from '@neuroflow/observability';
import {
  RunCancelledError,
  selectForSummary,
  StageError,
  summarizeConversation,
  summaryModel,
  toRunError,
} from '@neuroflow/orchestrator';
import { CodeWorkspaceError } from '@neuroflow/code';
import { finishCodeRun, prepareCodeRun } from './code-run';
import type { WorkerRuntime } from './runtime';

export class WorkerShutdownError extends Error {
  constructor() {
    super('Worker shutting down; the run will be retried by another worker');
    this.name = 'WorkerShutdownError';
  }
}

export type ProcessorDeps = {
  pool: Pool;
  redis: Redis;
  runtime: WorkerRuntime;
  logger: Logger;
  /** Aborted when the worker is shutting down (distinct from user cancellation). */
  shutdownSignal: AbortSignal;
  errors?: ErrorReporter;
};

/**
 * Run failures someone has to act on. Timeouts, provider rate limits and outages, budgets and
 * empty answers are expected under load (retries, fallbacks and the circuit breaker handle them)
 * and are visible in metrics instead.
 */
export const REPORTED_RUN_ERRORS = new Set(['internal', 'code_workspace_unavailable', 'model_auth', 'model_bad_request', 'model_model_not_found', 'model_provider_error']);

/**
 * Executes one run end-to-end. Orchestration failures are persisted as run failures (and not
 * re-thrown), so model/tool work is never blindly repeated. Only infrastructure failures and
 * worker shutdown propagate, letting BullMQ retry the job on another worker.
 */
export async function processRun(job: RunJobData, deps: ProcessorDeps): Promise<void> {
  return withExtractedContext(job.trace, () =>
    withSpan('run.process', { 'run.id': job.runId, 'workspace.id': job.workspaceId }, () => processInner(job, deps)),
  );
}

async function processInner(job: RunJobData, deps: ProcessorDeps): Promise<void> {
  const { pool, redis, runtime, logger } = deps;
  const log = logger.child({ runId: job.runId, workspaceId: job.workspaceId });

  const existing = await runsRepo.get(pool, job.runId);
  if (!existing || existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
    log.info({ status: existing?.status }, 'run already finished; skipping');
    return;
  }

  const emitter = new RunEventEmitter({
    db: pool,
    redis,
    runId: job.runId,
    startSeq: await runEventsRepo.maxSeq(pool, job.runId),
    onError: (err) => log.error({ err }, 'failed to persist/publish run event'),
    onPersisted: (event) => runtime.webhooks.fromRunEvent(job.workspaceId, event),
  });

  const run = await runsRepo.markStarted(pool, job.runId);
  if (!run) {
    // Cancelled while queued.
    if (await runsRepo.markCancelled(pool, job.runId)) {
      emitter.emit('run.cancelled', { reason: 'Cancelled before execution started' });
      await emitter.flush();
    }
    return;
  }

  const queueLatencyMs = Math.max(0, Date.now() - job.enqueuedAt);
  runtimeMetrics.queueLatency.record(queueLatencyMs);
  if (run.attempt > 1) {
    // Recovered after a worker crash/shutdown: the previous partial answer is discarded.
    emitter.emit('response.reset', { reason: 'Execution restarted after a worker interruption' });
  }
  emitter.emit('run.started', { attempt: run.attempt, queueLatencyMs });
  log.info({ attempt: run.attempt, queueLatencyMs }, 'run started');

  const controller = new AbortController();
  const offControl = runtime.control.on(job.runId, (msg) => {
    if (msg.type === 'cancel') controller.abort(new RunCancelledError(msg.reason));
  });
  // Backup for lost pub/sub messages: poll the durable cancellation flag.
  const poll = setInterval(() => {
    void runsRepo.isCancelRequested(pool, job.runId).then(
      (yes) => yes && controller.abort(new RunCancelledError()),
      () => {},
    );
  }, 2_000);
  const onShutdown = () => controller.abort(new WorkerShutdownError());
  deps.shutdownSignal.addEventListener('abort', onShutdown, { once: true });

  const started = Date.now();
  try {
    const [summary, settings] = await Promise.all([
      run.conversationId ? conversationsRepo.getSummary(pool, run.conversationId) : null,
      workspaceRepo.getSettings(pool, run.workspaceId),
    ]);
    const history = await loadHistory(pool, run.conversationId, summary?.uptoPosition ?? null);
    const wc = run.request.workspaceContext;
    const codeContext = wc
      ? await prepareCodeRun({ pool, code: runtime.code, runId: run.id, workspaceId: run.workspaceId, wc, emit: (t, d) => emitter.emit(t, d) })
      : undefined;
    // The run calls models with the workspace's own keys when it has them (BYOK).
    const gateway = await runtime.gatewayFor(run.workspaceId);
    const outcome = await runtime.orchestrator.execute({
      gateway,
      context: {
        ...(settings?.instructions ? { workspaceInstructions: settings.instructions } : {}),
        ...(summary?.summary ? { conversationSummary: summary.summary } : {}),
        ...(codeContext ? { code: codeContext } : {}),
      },
      run: {
        id: run.id,
        workspaceId: run.workspaceId,
        userId: run.userId,
        conversationId: run.conversationId,
        mode: run.mode,
      },
      request: run.request,
      history,
      scopes: run.scopes,
      signal: controller.signal,
      emit: (type, data) => emitter.emit(type, data),
    });

    if (run.conversationId) {
      await messagesRepo.append(
        pool,
        run.conversationId,
        [{ role: 'assistant', content: outcome.output, ...(outcome.toolCalls ? { toolCalls: outcome.toolCalls } : {}) }],
        run.id,
      );
      await conversationsRepo.touch(pool, run.conversationId);
    }
    await runsRepo.complete(pool, run.id, outcome.output, outcome.usage, outcome.toolCalls);
    if (wc) await finishCodeRun({ pool, code: runtime.code, runId: run.id, workspaceId: run.workspaceId, wc, status: 'completed', emit: (t, d) => emitter.emit(t, d) }).catch((err) => log.warn({ err }, 'code run summary failed'));
    const durationMs = Date.now() - started;
    emitter.emit('run.completed', {
      durationMs,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(outcome.toolCalls ? { toolCalls: outcome.toolCalls } : {}),
    });
    if (outcome.usage?.costUsd !== undefined) runtimeMetrics.cost.add(outcome.usage.costUsd, { strategy: outcome.plan.agentStrategy });
    if (run.conversationId) {
      // Best effort and off the critical path: the answer is already delivered.
      void refreshSummary(deps, run.conversationId, summary).catch((err) => log.warn({ err }, 'conversation summary failed'));
    }
    runtimeMetrics.runDuration.record(durationMs, { status: 'completed', strategy: outcome.plan.agentStrategy });
    runtimeMetrics.runsTotal.add(1, { status: 'completed' });
    log.info({ durationMs, strategy: outcome.plan.agentStrategy }, 'run completed');
  } catch (err) {
    const cause = err instanceof StageError ? err.cause : err;
    const partial = err instanceof StageError ? err.partialOutput : '';
    const reason = controller.signal.reason;

    if (reason instanceof WorkerShutdownError) {
      log.warn('run interrupted by worker shutdown; releasing for retry');
      await emitter.flush();
      throw reason;
    }

    if (cause instanceof RunCancelledError || reason instanceof RunCancelledError) {
      if (partial && run.conversationId) {
        await messagesRepo.append(pool, run.conversationId, [{ role: 'assistant', content: partial }], run.id);
      }
      await runsRepo.markCancelled(pool, run.id, partial);
      if (run.request.workspaceContext) {
        await finishCodeRun({ pool, code: runtime.code, runId: run.id, workspaceId: run.workspaceId, wc: run.request.workspaceContext, status: 'cancelled', emit: (t, d) => emitter.emit(t, d) }).catch(() => {});
      }
      emitter.emit('run.cancelled', { reason: 'Cancelled by user' });
      runtimeMetrics.runsTotal.add(1, { status: 'cancelled' });
      log.info('run cancelled');
    } else {
      const error =
        cause instanceof CodeWorkspaceError
          ? { code: 'code_workspace_unavailable', message: cause.message, stage: 'repository' }
          : toRunError(cause, err instanceof StageError ? err.stage : undefined);
      await runsRepo.fail(pool, run.id, error, partial);
      if (run.request.workspaceContext) {
        await finishCodeRun({ pool, code: runtime.code, runId: run.id, workspaceId: run.workspaceId, wc: run.request.workspaceContext, status: 'failed', emit: (t, d) => emitter.emit(t, d) }).catch(() => {});
      }
      emitter.emit('run.failed', { error });
      runtimeMetrics.runsTotal.add(1, { status: 'failed' });
      log.warn({ err: cause, code: error.code, stage: error.stage }, 'run failed');
      if (REPORTED_RUN_ERRORS.has(error.code)) {
        deps.errors?.capture(cause, { tags: { kind: 'run_failed', code: error.code, stage: error.stage ?? 'unknown' }, extra: { runId: run.id } });
      }
    }
  } finally {
    clearInterval(poll);
    offControl();
    deps.shutdownSignal.removeEventListener('abort', onShutdown);
    await emitter.flush();
  }
}

/** History after the summarised prefix. Tool exchanges keep their call ids (client tools). */
async function loadHistory(pool: Pool, conversationId: string | null, afterPosition: number | null): Promise<ChatMessage[]> {
  if (!conversationId) return [];
  const messages = await messagesRepo.listByConversation(pool, conversationId, 200, afterPosition);
  return messages.map(({ role, content, toolCalls, toolCallId, name }) => ({
    role,
    content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(name ? { name } : {}),
  }));
}

/** Folds older turns into the rolling conversation summary once enough have accumulated. */
export async function refreshSummary(
  deps: Pick<ProcessorDeps, 'pool' | 'runtime'>,
  conversationId: string,
  current: { summary: string | null; uptoPosition: number | null } | null,
): Promise<boolean> {
  const unsummarized = await messagesRepo.listAfter(deps.pool, conversationId, current?.uptoPosition ?? null);
  const fold = selectForSummary(unsummarized);
  if (!fold?.length) return false;
  // Summaries are model calls too: they use the conversation's workspace keys.
  const owner = (await deps.pool.query('SELECT workspace_id FROM conversations WHERE id = $1', [conversationId])).rows[0];
  const gateway = owner ? await deps.runtime.gatewayFor(owner.workspace_id as string) : deps.runtime.gateway;
  const model = summaryModel(gateway.listModels(), gateway.defaultModel());
  if (!model) return false;
  const summary = await summarizeConversation(gateway, {
    model,
    previousSummary: current?.summary ?? null,
    messages: fold,
    signal: AbortSignal.timeout(120_000),
  });
  await conversationsRepo.setSummary(deps.pool, conversationId, summary, fold.at(-1)!.position);
  return true;
}
