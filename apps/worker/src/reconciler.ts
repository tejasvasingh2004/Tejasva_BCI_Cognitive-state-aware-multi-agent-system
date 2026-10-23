import type { Pool } from '@neuroflow/db';
import { RunEventEmitter, runPriority, type Redis, type RunQueue, type WebhookService } from '@neuroflow/bus';
import { auditRepo, runEventsRepo, runsRepo } from '@neuroflow/db';
import type { MemoryService } from '@neuroflow/memory';
import type { Logger } from '@neuroflow/observability';

/**
 * Repairs runs whose queue job disappeared (e.g. Redis data loss, enqueue failure after commit,
 * or a job that exhausted its retries). Queued runs are re-enqueued; running runs are failed.
 */
export async function reconcileRuns(deps: {
  pool: Pool;
  redis: Redis;
  queue: RunQueue;
  logger: Logger;
  staleAfterMs?: number;
  webhooks?: WebhookService;
}): Promise<{ requeued: number; failed: number }> {
  const stale = await runsRepo.findStale(deps.pool, deps.staleAfterMs ?? 15 * 60_000);
  let requeued = 0;
  let failed = 0;
  for (const run of stale) {
    if (await deps.queue.isActive(run.id)) continue;
    if (run.status === 'queued' && !run.cancelRequestedAt) {
      await deps.queue.enqueue({ runId: run.id, workspaceId: run.workspaceId }, { priority: runPriority(run.source) });
      requeued++;
      continue;
    }
    const error = { code: 'worker_lost', message: 'The run was interrupted and could not be recovered.', stage: 'worker' };
    const cancelled = Boolean(run.cancelRequestedAt);
    const changed = cancelled ? await runsRepo.markCancelled(deps.pool, run.id) : await runsRepo.fail(deps.pool, run.id, error);
    if (changed) {
      const emitter = new RunEventEmitter({
        db: deps.pool,
        redis: deps.redis,
        runId: run.id,
        startSeq: await runEventsRepo.maxSeq(deps.pool, run.id),
        ...(deps.webhooks ? { onPersisted: (event) => deps.webhooks!.fromRunEvent(run.workspaceId, event) } : {}),
      });
      if (cancelled) emitter.emit('run.cancelled', { reason: 'Cancelled' });
      else emitter.emit('run.failed', { error });
      await emitter.flush();
      failed++;
    }
  }
  if (requeued || failed) deps.logger.warn({ requeued, failed }, 'reconciled stale runs');
  return { requeued, failed };
}

/** Applies memory retention (TTLs + workspace policy) and records it in the audit trail. */
export async function purgeExpiredMemories(deps: { pool: Pool; memory: MemoryService; logger: Logger }): Promise<number> {
  const purged = await deps.memory.purgeExpired();
  for (const p of purged) {
    await auditRepo.record(deps.pool, {
      action: 'memory.expired',
      workspaceId: p.workspaceId,
      actorVia: 'system',
      metadata: { count: p.count },
    });
  }
  const total = purged.reduce((n, p) => n + p.count, 0);
  if (total) deps.logger.info({ total }, 'expired memories purged');
  return total;
}
