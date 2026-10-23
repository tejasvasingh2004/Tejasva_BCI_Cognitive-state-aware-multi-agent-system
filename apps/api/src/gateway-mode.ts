import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ChatMessage, Principal, ReasoningBudget, ToolCall, Usage } from '@neuroflow/contracts';
import { ResponseCache, spendLimitMessage, type BudgetService } from '@neuroflow/bus';
import { auditRepo, recordGatewayCall, type Pool, type ProviderKeyVault } from '@neuroflow/db';
import { ModelError, type DefaultModelGateway, type ModelGateway, type ModelRequest, type ToolSpec } from '@neuroflow/models';
import { runtimeMetrics } from '@neuroflow/observability';
import type { AppDeps } from './deps';
import { HttpError } from './errors';
import { openSse } from './sse';

const CREDENTIALS_TTL_MS = 30_000;

/**
 * Per-workspace gateway views for gateway mode: the workspace's own provider keys (decrypted on
 * the API, cached for 30 s per process) plus platform keys when allowed, and the budget guard that
 * workers also apply before every call.
 */
export class WorkspaceGateways {
  private readonly cache = new Map<string, { at: number; gateway: ModelGateway }>();

  constructor(
    private readonly gateway: DefaultModelGateway,
    private readonly keys: ProviderKeyVault,
    private readonly budgets: BudgetService,
    private readonly platformKeys: boolean,
    private readonly pool?: Pool,
  ) {}

  async forWorkspace(workspaceId: string): Promise<ModelGateway> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CREDENTIALS_TTL_MS) return hit.gateway;
    const credentials = await this.keys.credentials(workspaceId);
    const gateway = this.gateway.scoped(credentials, {
      platformKeys: this.platformKeys,
      guard: async ({ keyId }) => {
        const block = await this.budgets.callBlock(workspaceId, keyId);
        return block ? new ModelError('spend_limit', spendLimitMessage(block), { retryable: false }) : undefined;
      },
      onCredentialRejected: async ({ provider, keyId }) => {
        this.invalidate(workspaceId);
        if (!(await this.keys.invalidate(workspaceId, keyId, 'The provider rejected this key during a run (HTTP 401). Check or replace it.'))) return;
        if (this.pool) {
          await auditRepo.record(this.pool, {
            action: 'provider_key.invalidated',
            outcome: 'failure',
            workspaceId,
            actorVia: 'system',
            targetType: 'provider_key',
            targetId: keyId,
            metadata: { provider, reason: 'rejected_by_provider' },
          });
        }
      },
    });
    this.cache.set(workspaceId, { at: Date.now(), gateway });
    return gateway;
  }

  /** After a workspace's keys change on this server. */
  invalidate(workspaceId: string) {
    this.cache.delete(workspaceId);
  }
}

export type GatewayCompletionInput = {
  /** Model ref, or undefined for the workspace's default model. */
  model?: string;
  displayModel: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ModelRequest['toolChoice'];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningBudget?: ReasoningBudget;
  responseFormat?: 'text' | 'json';
  stream: boolean;
  cacheTtlSeconds?: number;
  hedgeAfterMs?: number;
  options: Record<string, unknown>;
};

const toOpenAIUsage = (u?: Usage) =>
  u
    ? {
        prompt_tokens: u.promptTokens,
        completion_tokens: u.completionTokens,
        total_tokens: u.totalTokens,
        ...(u.cachedPromptTokens ? { prompt_tokens_details: { cached_tokens: u.cachedPromptTokens } } : {}),
      }
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

const toOpenAIToolCall = (c: ToolCall) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } });

/**
 * Gateway mode: a single model call streamed from the API process. Same authentication, rate
 * limits, quotas, budgets, workspace keys, retries, fallbacks and usage records as a run, without
 * the queue hop and worker pickup. Overhead (request arrival → provider request) is reported in
 * `server-timing` and the `neuroflow.gateway.overhead` metric.
 */
export async function serveGatewayCompletion(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, principal: Principal, input: GatewayCompletionInput, admit: () => Promise<void>) {
  const arrived = performance.now();
  const [gateway] = await Promise.all([deps.gateways.forWorkspace(principal.workspaceId), admit()]);
  const ref = input.model ?? gateway.defaultModel();
  if (!ref) throw new HttpError('unavailable', 'No model is available for this workspace. Add a provider key in Settings.');
  const id = `chatcmpl-gw-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = input.model ? input.displayModel : ref;

  // Response cache (opt-in, single-turn, tool-free, per workspace).
  const cache = input.cacheTtlSeconds && ResponseCache.eligible(input.messages, Boolean(input.tools?.length)) ? deps.responseCache : undefined;
  const cacheKey = cache?.key({
    workspaceId: principal.workspaceId,
    ref,
    messages: input.messages,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.reasoningBudget ? { reasoningBudget: input.reasoningBudget } : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
  });
  if (cache && cacheKey) {
    const hit = await cache.get(cacheKey);
    if (hit) {
      runtimeMetrics.responseCache.add(1, { result: 'hit' });
      const latencyMs = performance.now() - arrived;
      reply.header('x-neuroflow-cache', 'hit').header('server-timing', `overhead;dur=${latencyMs.toFixed(1)}`);
      void record(deps, principal, input, { ref, provider: ref.split('/')[0]!, status: 'completed', output: hit.text, finishReason: hit.finishReason, latencyMs, firstTokenMs: latencyMs, attempts: 0, cacheHit: true });
      return respond(req, reply, input.stream, { id, created, model, text: hit.text, toolCalls: [], finishReason: hit.finishReason === 'length' ? 'length' : 'stop', usage: undefined, cache: 'hit' });
    }
    runtimeMetrics.responseCache.add(1, { result: 'miss' });
  }

  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.raw.on('close', onClose);
  const events = gateway.stream({
    model: ref,
    messages: input.messages,
    ...(input.tools?.length ? { tools: input.tools, toolChoice: input.toolChoice ?? 'auto' } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.reasoningBudget ? { reasoningBudget: input.reasoningBudget } : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
    ...(input.hedgeAfterMs ? { hedge: { afterMs: input.hedgeAfterMs } } : {}),
    signal: controller.signal,
  })[Symbol.asyncIterator]();

  let overheadMs: number | undefined;
  let sse: ReturnType<typeof openSse> | undefined;
  let text = '';
  const toolCalls: ToolCall[] = [];
  const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
    sse?.send({ data: { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra } });
  const startStream = () => {
    if (!input.stream || sse) return;
    reply.header('x-neuroflow-mode', 'gateway').header('server-timing', `overhead;dur=${(overheadMs ?? 0).toFixed(1)}`);
    if (cache) reply.header('x-neuroflow-cache', 'miss');
    sse = openSse(req, reply);
    chunk({ role: 'assistant', content: '' }, null);
  };

  try {
    for (;;) {
      const { value: ev, done } = await events.next();
      if (done) break;
      if (ev.type === 'attempt' && overheadMs === undefined) {
        overheadMs = performance.now() - arrived;
        runtimeMetrics.gatewayOverhead.record(overheadMs, { provider: ev.provider });
      } else if (ev.type === 'delta') {
        startStream();
        text += ev.text;
        chunk({ content: ev.text }, null);
      } else if (ev.type === 'tool_call') {
        toolCalls.push(ev.call);
      } else if (ev.type === 'done') {
        const res = ev.response;
        const finish = res.toolCalls.length ? 'tool_calls' : res.finishReason === 'length' ? 'length' : 'stop';
        void record(deps, principal, input, {
          ref: res.ref,
          provider: res.provider,
          status: 'completed',
          output: res.text,
          toolCalls: res.toolCalls,
          ...(res.usage ? { usage: res.usage } : {}),
          finishReason: res.finishReason,
          latencyMs: performance.now() - arrived,
          ...(res.firstTokenMs !== undefined ? { firstTokenMs: res.firstTokenMs } : {}),
          attempts: res.attempts,
          ...(res.fallbackFrom ? { fallbackFrom: res.fallbackFrom } : {}),
          ...(res.keyId ? { providerKeyId: res.keyId } : {}),
        });
        if (cache && cacheKey && finish === 'stop' && res.text) {
          void cache.set(cacheKey, { text: res.text, finishReason: res.finishReason, ref: res.ref, ...(res.usage ? { usage: res.usage } : {}), createdAt: new Date().toISOString() }, input.cacheTtlSeconds!).catch(() => {});
        }
        if (!input.stream) {
          reply.header('x-neuroflow-mode', 'gateway').header('server-timing', `overhead;dur=${(overheadMs ?? 0).toFixed(1)}`);
          if (cache) reply.header('x-neuroflow-cache', 'miss');
          return respond(req, reply, false, { id, created, model: input.model ? model : res.ref, text: res.text, toolCalls: res.toolCalls, finishReason: finish, usage: res.usage, overheadMs, ttftMs: res.firstTokenMs });
        }
        startStream();
        if (res.toolCalls.length) chunk({ tool_calls: res.toolCalls.map((c, index) => ({ index, ...toOpenAIToolCall(c) })) }, null);
        chunk({}, finish);
        if (res.usage) sse!.send({ data: { id, object: 'chat.completion.chunk', created, model, choices: [], usage: toOpenAIUsage(res.usage) } });
        sse!.send({ data: '[DONE]' });
        sse!.close();
        return;
      }
    }
  } catch (err) {
    const error = err instanceof ModelError ? err : new ModelError('provider_error', err instanceof Error ? err.message : String(err));
    void record(deps, principal, input, {
      ref,
      provider: ref.split('/')[0]!,
      status: error.code === 'cancelled' ? 'cancelled' : 'failed',
      output: text,
      error: { code: `model_${error.code}`, message: error.message.slice(0, 300) },
      latencyMs: performance.now() - arrived,
      attempts: 1,
    });
    if (sse) {
      sse.send({ data: { error: { message: error.message, type: 'server_error', code: error.code } } });
      sse.send({ data: '[DONE]' });
      sse.close();
      return;
    }
    if (error.code === 'spend_limit') throw new HttpError('quota_exceeded', error.message);
    if (error.code === 'rate_limited') throw new HttpError('rate_limited', error.message, undefined, true, error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : undefined);
    if (error.code === 'auth') throw new HttpError('bad_request', error.message);
    if (error.code === 'model_not_found') throw new HttpError('not_found', error.message);
    throw new HttpError('unavailable', error.message, { code: `model_${error.code}` }, error.retryable);
  } finally {
    req.raw.off('close', onClose);
  }
}

function respond(
  req: FastifyRequest,
  reply: FastifyReply,
  stream: boolean,
  r: { id: string; created: number; model: string; text: string; toolCalls: ToolCall[]; finishReason: string; usage: Usage | undefined; cache?: 'hit'; overheadMs?: number; ttftMs?: number },
) {
  if (stream) {
    const sse = openSse(req, reply);
    const base = { id: r.id, object: 'chat.completion.chunk', created: r.created, model: r.model };
    sse.send({ data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: r.text }, finish_reason: null }] } });
    sse.send({ data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: r.finishReason }] } });
    sse.send({ data: '[DONE]' });
    sse.close();
    return;
  }
  return reply.send({
    id: r.id,
    object: 'chat.completion',
    created: r.created,
    model: r.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: r.toolCalls.length && !r.text ? null : r.text,
          ...(r.toolCalls.length ? { tool_calls: r.toolCalls.map(toOpenAIToolCall) } : {}),
        },
        finish_reason: r.finishReason,
      },
    ],
    usage: toOpenAIUsage(r.usage),
    neuroflow: {
      mode: 'gateway',
      ...(r.cache ? { cache: r.cache } : {}),
      ...(r.overheadMs !== undefined ? { overhead_ms: Math.round(r.overheadMs * 10) / 10 } : {}),
      ...(r.ttftMs !== undefined ? { ttft_ms: r.ttftMs } : {}),
      ...(r.usage?.costUsd !== undefined ? { cost_usd: r.usage.costUsd } : {}),
    },
  });
}

/** Usage, budgets and history after the response (never on the request path). */
async function record(deps: AppDeps, principal: Principal, input: GatewayCompletionInput, c: Omit<Parameters<typeof recordGatewayCall>[1], 'workspaceId' | 'userId' | 'scopes' | 'options'>) {
  try {
    await recordGatewayCall(deps.pool, { ...c, workspaceId: principal.workspaceId, userId: principal.userId, scopes: principal.scopes, options: input.options });
    if (c.usage?.totalTokens) await deps.usage.addTokens(principal.workspaceId, c.usage.totalTokens);
    if (c.usage?.costUsd) await deps.budgets.record({ workspaceId: principal.workspaceId, costUsd: c.usage.costUsd, ...(c.providerKeyId ? { keyId: c.providerKeyId } : {}) });
  } catch (err) {
    deps.logger.warn({ err }, 'failed to record gateway call');
  }
}
