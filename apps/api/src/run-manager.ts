import type { AuditAction, Principal, RunRequest } from '@neuroflow/contracts';
import { RunEventEmitter, runPriority } from '@neuroflow/bus';
import {
  auditRepo,
  conversationsRepo,
  deriveTitle,
  messagesRepo,
  runEventsRepo,
  runsRepo,
  withTransaction,
  type RunRow,
  type RunSource,
} from '@neuroflow/db';
import { injectTraceContext, withSpan } from '@neuroflow/observability';
import type { AppDeps } from './deps';
import { HttpError, notFound } from './errors';

export type CreateRunResult = { run: RunRow; conversationId: string; created: boolean };

/**
 * Run Manager: admission control → durable run creation → queue. It never executes model or tool
 * work; the handler returns as soon as the run is queued.
 */
export class RunManager {
  constructor(private readonly deps: AppDeps) {}

  async create(
    principal: Principal,
    request: RunRequest,
    opts: { source: RunSource; idempotencyKey?: string },
  ): Promise<CreateRunResult> {
    return withSpan('run.create', { 'workspace.id': principal.workspaceId, 'run.source': opts.source }, async (span) => {
      await this.admit(principal);

      const result = await withTransaction(this.deps.pool, async (tx) => {
        let conversationId = request.conversationId;
        if (conversationId) {
          const conv = await conversationsRepo.get(tx, principal.workspaceId, conversationId);
          if (!conv) throw notFound('Conversation');
        } else {
          conversationId = (await conversationsRepo.create(tx, principal)).id;
        }
        const created = await runsRepo.create(tx, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          conversationId,
          request,
          source: opts.source,
          scopes: principal.scopes,
          idempotencyKey: opts.idempotencyKey,
        });
        if (created.created) {
          await messagesRepo.append(tx, conversationId, request.messages, created.run.id);
          const firstUser = request.messages.find((m) => m.role === 'user');
          if (firstUser) await conversationsRepo.titleIfDefault(tx, conversationId, deriveTitle(firstUser.content));
          await conversationsRepo.touch(tx, conversationId);
        }
        return { run: created.run, conversationId, created: created.created };
      });
      span.setAttribute('run.id', result.run.id);
      if (!result.created) return result;

      // Both events are persisted *before* enqueueing so the worker (which continues numbering from
      // the last persisted sequence) can never race the API for an event sequence number.
      const emitter = new RunEventEmitter({ db: this.deps.pool, redis: this.deps.redis, runId: result.run.id, startSeq: 0 });
      emitter.emit('run.created', { mode: result.run.mode });
      emitter.emit('run.queued', {});
      await emitter.flush();
      try {
        await this.deps.queue.enqueue(
          { runId: result.run.id, workspaceId: principal.workspaceId, trace: injectTraceContext() },
          { priority: runPriority(opts.source) },
        );
      } catch (err) {
        this.deps.logger.error({ err, runId: result.run.id }, 'failed to enqueue run');
        const error = { code: 'queue_unavailable', message: 'The execution queue is unavailable. Please retry.', stage: 'queue' };
        await runsRepo.fail(this.deps.pool, result.run.id, error);
        emitter.emit('run.failed', { error });
        await emitter.flush();
        throw new HttpError('unavailable', error.message, undefined, true);
      }
      void this.audit(principal, 'run.created', result.run.id, { source: opts.source, mode: result.run.mode });
      return result;
    });
  }

  async cancel(principal: Principal, runId: string): Promise<RunRow> {
    const run = await runsRepo.get(this.deps.pool, runId, principal.workspaceId);
    if (!run) throw notFound('Run');
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return run;

    const updated = await runsRepo.requestCancel(this.deps.pool, runId, principal.workspaceId);
    if (!updated) return (await runsRepo.get(this.deps.pool, runId, principal.workspaceId))!;

    // Not started yet: remove from the queue and finalise here. Otherwise signal the worker.
    if (updated.status === 'queued' && (await this.deps.queue.removeIfWaiting(runId))) {
      if (await runsRepo.markCancelled(this.deps.pool, runId)) {
        const emitter = new RunEventEmitter({
          db: this.deps.pool,
          redis: this.deps.redis,
          runId,
          startSeq: await runEventsRepo.maxSeq(this.deps.pool, runId),
        });
        emitter.emit('run.cancelled', { reason: 'Cancelled before execution started' });
        await emitter.flush();
      }
    } else {
      await this.deps.control.cancel(runId);
    }
    void this.audit(principal, 'run.cancelled', runId);
    return (await runsRepo.get(this.deps.pool, runId, principal.workspaceId))!;
  }

  async approve(principal: Principal, runId: string, toolCallId: string, approved: boolean, reason?: string) {
    const run = await runsRepo.get(this.deps.pool, runId, principal.workspaceId);
    if (!run) throw notFound('Run');
    if (run.status !== 'running') throw new HttpError('conflict', 'Run is not awaiting approval');
    // Approval is a user decision: only the run's owner may approve its tool calls.
    if (run.userId !== principal.userId) throw new HttpError('forbidden', 'Only the run owner can approve actions');
    await this.deps.control.approval(runId, toolCallId, approved, reason);
    void this.audit(principal, 'tool.approval_decided', runId, { toolCallId, approved });
  }

  private audit(principal: Principal, action: AuditAction, runId: string, metadata: Record<string, unknown> = {}) {
    return auditRepo
      .record(this.deps.pool, {
        action,
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorVia: principal.via === 'api_key' ? `api_key:${principal.apiKeyId ?? ''}` : 'session',
        targetType: 'run',
        targetId: runId,
        metadata,
      })
      .catch((err) => this.deps.logger.error({ err, action }, 'failed to write audit event'));
  }

  /** Backpressure: bounded active runs per workspace and per user, and bounded queue backlog. */
  private async admit(principal: Principal) {
    const [active, activeForUser, backlog] = await Promise.all([
      runsRepo.countActive(this.deps.pool, principal.workspaceId),
      runsRepo.countActiveForUser(this.deps.pool, principal.userId),
      this.deps.queue.backlog(),
    ]);
    if (active >= this.deps.config.MAX_ACTIVE_RUNS_PER_WORKSPACE) {
      throw new HttpError('rate_limited', 'Too many active runs in this workspace. Wait for one to finish.', undefined, true);
    }
    if (activeForUser >= this.deps.config.MAX_ACTIVE_RUNS_PER_USER) {
      throw new HttpError('rate_limited', 'You already have the maximum number of active runs. Wait for one to finish.', undefined, true);
    }
    if (backlog >= this.deps.config.MAX_QUEUE_BACKLOG) {
      throw new HttpError('overloaded', 'NeuroFlow is at capacity. Please retry shortly.', undefined, true);
    }
  }
}
