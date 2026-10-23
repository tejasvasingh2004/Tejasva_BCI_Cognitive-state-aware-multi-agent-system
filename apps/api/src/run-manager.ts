import type { AuditAction, PlanDecisionBody, Principal, RunRequest } from '@neuroflow/contracts';
import { RunEventEmitter, runPriority, spendLimitMessage, UsageMeter, webhookUrlProblem } from '@neuroflow/bus';
import {
  auditRepo,
  codeApprovalsRepo,
  modelLabRepo,
  patchesRepo,
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
      if (request.webhookUrl) {
        // Async runs: the callback URL gets the same destination checks as webhook endpoints.
        const problem = webhookUrlProblem(request.webhookUrl, { allowPrivate: this.deps.config.WEBHOOK_ALLOW_PRIVATE });
        if (problem) throw new HttpError('bad_request', `webhookUrl: ${problem}`);
      }
      const admission = await this.admit(principal);
      request = await this.applyModelLab(principal, request);

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
          { priority: runPriority(opts.source, admission.queuePriority) },
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
          onPersisted: (event) => this.deps.webhooks.fromRunEvent(principal.workspaceId, event),
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
    if (run.request.workspaceContext) void this.recordCodeApproval(principal, runId, toolCallId, approved, reason);
  }

  /**
   * Plan Review decision: approve (optionally with edited steps), request a revision with
   * feedback, or stop. Delivered over the same control channel as tool approvals.
   */
  async decidePlan(principal: Principal, runId: string, decision: PlanDecisionBody) {
    const run = await runsRepo.get(this.deps.pool, runId, principal.workspaceId);
    if (!run) throw notFound('Run');
    if (run.status !== 'running') throw new HttpError('conflict', 'Run is not awaiting a plan decision');
    if (run.userId !== principal.userId) throw new HttpError('forbidden', 'Only the run owner can review its plan');
    const approved = decision.decision === 'approve';
    const feedback = decision.decision === 'approve' ? undefined : decision.feedback;
    const data = {
      decision: decision.decision,
      ...(decision.decision === 'approve' && decision.steps ? { steps: decision.steps } : {}),
      ...(decision.decision === 'approve' && decision.summary ? { summary: decision.summary } : {}),
    };
    await this.deps.control.approval(runId, decision.planId, approved, feedback, data);
    void this.audit(principal, 'tool.approval_decided', runId, { toolCallId: decision.planId, approved, plan: decision.decision });
    void codeApprovalsRepo
      .record(this.deps.pool, {
        workspaceId: principal.workspaceId,
        runId,
        subjectType: 'plan',
        subjectId: decision.planId,
        toolCallId: decision.planId,
        decision: approved ? 'approved' : 'rejected',
        decidedBy: principal.userId,
        ...(feedback ? { reason: feedback } : {}),
      })
      .catch(() => {});
  }

  /** Explicit record of a human decision on a Code Agent action (patch, command, git, PR). */
  private async recordCodeApproval(principal: Principal, runId: string, toolCallId: string, approved: boolean, reason?: string) {
    try {
      const { rows } = await this.deps.pool.query('SELECT name FROM tool_calls WHERE run_id = $1 AND tool_call_id = $2', [runId, toolCallId]);
      const tool = (rows[0]?.name as string | undefined) ?? '';
      const patch = await patchesRepo.findByToolCall(this.deps.pool, runId, toolCallId);
      const subjectType = patch
        ? tool === 'delete_file'
          ? 'delete'
          : 'patch'
        : tool.startsWith('run_')
          ? 'command'
          : tool === 'commit' || tool === 'push'
            ? tool
            : tool === 'create_pull_request'
              ? 'pull_request'
              : 'other';
      await codeApprovalsRepo.record(this.deps.pool, {
        workspaceId: principal.workspaceId,
        runId,
        subjectType,
        subjectId: patch?.id,
        toolCallId,
        decision: approved ? 'approved' : 'rejected',
        decidedBy: principal.userId,
        reason,
      });
    } catch (err) {
      this.deps.logger.error({ err, runId }, 'failed to record code approval');
    }
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

  /**
   * Model Lab configuration: per-surface defaults (fill only what the request leaves unset) and
   * deployments ("deployment/<name>" → model + parameters + system prompt).
   */
  private async applyModelLab(principal: Principal, request: RunRequest): Promise<RunRequest> {
    const scope = request.workspaceContext ? 'code_agent' : 'default';
    const config = await modelLabRepo.getConfig(this.deps.pool, principal.workspaceId, scope);
    const r: RunRequest = { ...request };
    if (config) {
      if (!r.selectedModel && config.model && config.model !== 'auto') r.selectedModel = config.model;
      if (r.temperature === undefined && config.temperature !== undefined) r.temperature = config.temperature;
      if (r.maxOutputTokens === undefined && config.maxOutputTokens !== undefined) r.maxOutputTokens = config.maxOutputTokens;
      if (r.reasoningBudget === undefined && config.reasoningBudget) r.reasoningBudget = config.reasoningBudget;
      if (r.agentStrategy === 'auto' && config.agentStrategy && config.agentStrategy !== 'auto' && !r.workspaceContext) r.agentStrategy = config.agentStrategy;
      if (r.tools === undefined && config.tools) r.tools = config.tools;
    }
    if (r.selectedModel?.startsWith('deployment/')) {
      const name = r.selectedModel.slice('deployment/'.length);
      const d = await modelLabRepo.getDeployment(this.deps.pool, principal.workspaceId, name);
      if (!d || d.status !== 'active') throw new HttpError('not_found', `Deployment "${name}" does not exist or is disabled`);
      r.selectedModel = d.model;
      if (r.temperature === undefined && d.parameters.temperature !== undefined) r.temperature = d.parameters.temperature;
      if (r.maxOutputTokens === undefined && d.parameters.maxOutputTokens !== undefined) r.maxOutputTokens = d.parameters.maxOutputTokens;
      if (r.reasoningBudget === undefined && d.parameters.reasoningBudget) r.reasoningBudget = d.parameters.reasoningBudget;
      if (d.parameters.systemPrompt) r.messages = [{ role: 'system', content: d.parameters.systemPrompt }, ...r.messages];
      r.metadata = { ...(r.metadata ?? {}), 'neuroflow.deployment': d.name };
    }
    return r;
  }

  /**
   * Admission control (back-pressure) by plan: bounded active runs per workspace and per user,
   * the daily model-token quota, and a bounded global queue backlog. Returns the plan's queue
   * priority for the accepted run.
   */
  private async admit(principal: Principal): Promise<{ queuePriority: number }> {
    const [{ plan, limits }, active, activeForUser, backlog, tokensToday] = await Promise.all([
      this.deps.plans.limits(principal.workspaceId),
      runsRepo.countActive(this.deps.pool, principal.workspaceId),
      runsRepo.countActiveForUser(this.deps.pool, principal.userId),
      this.deps.queue.backlog(),
      this.deps.usage.tokensToday(principal.workspaceId),
    ]);
    if (active >= limits.activeRunsPerWorkspace) {
      throw new HttpError('rate_limited', `Your ${plan} plan allows ${limits.activeRunsPerWorkspace} active runs per workspace. Wait for one to finish.`, undefined, true, {
        retryAfterMs: 5_000,
      });
    }
    if (activeForUser >= limits.activeRunsPerUser) {
      throw new HttpError('rate_limited', 'You already have the maximum number of active runs. Wait for one to finish.', undefined, true, {
        retryAfterMs: 5_000,
      });
    }
    if (limits.dailyTokens !== null && tokensToday >= limits.dailyTokens) {
      const resetsAt = UsageMeter.resetsAt();
      throw new HttpError(
        'quota_exceeded',
        `Daily model-token quota of your ${plan} plan reached (${limits.dailyTokens.toLocaleString('en-US')} tokens). It resets at ${resetsAt.toISOString()}.`,
        { plan, dailyTokens: limits.dailyTokens, tokensToday, resetsAt: resetsAt.toISOString() },
        false,
        { retryAfterMs: resetsAt.getTime() - Date.now() },
      );
    }
    const spend = await this.deps.budgets.workspaceBlock(principal.workspaceId);
    if (spend) {
      throw new HttpError(
        'quota_exceeded',
        spendLimitMessage(spend),
        { scope: spend.scope, limitUsd: spend.limitUsd, spendUsd: Math.round(spend.spendUsd * 100) / 100, resetsAt: spend.resetsAt.toISOString() },
        false,
        { retryAfterMs: spend.resetsAt.getTime() - Date.now() },
      );
    }
    if (backlog >= this.deps.config.MAX_QUEUE_BACKLOG) {
      throw new HttpError('overloaded', 'NeuroFlow is at capacity. Please retry shortly.', undefined, true, { retryAfterMs: 10_000 });
    }
    return { queuePriority: limits.queuePriority };
  }
}
