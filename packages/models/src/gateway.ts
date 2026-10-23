import {
  estimateCostUsd,
  parseModelRef,
  type ModelInfo,
  type ModelPricing,
  type ProviderInfo,
  type ToolCall,
  type Usage,
} from '@neuroflow/contracts';
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER, PROVIDER_HEALTH_FAILURES, type CircuitBreakerOptions } from './circuit-breaker';
import { ModelError, isAbortError } from './errors';
import { estimateRequestTokens, InMemoryRateLimiter, type BucketLimits, type RateLimiter } from './rate-limit';
import type { CatalogEntry, CredentialCheck, FinishReason, ModelEvent, ModelGateway, ModelRequest, ModelResponse, ProviderAdapter, ProviderCredential, ProviderState, ModelCallGuard } from './types';

export type GatewayPolicy = {
  /** Retries per model for retryable errors that happen before any output is produced. */
  maxRetries: number;
  /** Hard timeout per attempt. */
  attemptTimeoutMs: number;
  /** Max wait for the first output (covers cold model loads). */
  firstTokenTimeoutMs: number;
  /** Max silence between chunks once streaming has started. */
  idleTimeoutMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Longest wait honoured when a provider rate-limits and says when to retry (e.g. per-minute token quotas). */
  maxRateLimitWaitMs: number;
  /** Default fallback chain applied when a request does not specify one. */
  defaultFallbacks: string[];
  /** Fail over to the same model on another provider before falling back to other models. */
  equivalentFailover: boolean;
  defaultModel?: string;
  /** Per-model pricing overrides keyed by model ref (USD per 1M tokens). */
  pricing: Map<string, ModelPricing>;
  /** Max concurrent attempts per provider id (unset = unlimited). Protects quotas and local GPUs. */
  providerConcurrency: Record<string, number>;
  /**
   * Budgets per provider, enforced before a request is sent: tokens/requests per minute per API
   * key, and concurrency across everyone sharing the limiter (all workers with the Redis limiter).
   */
  providerLimits: Record<string, ProviderLimits>;
  circuitBreaker: CircuitBreakerOptions;
};

export type ProviderLimits = { tokensPerMinute?: number; requestsPerMinute?: number; concurrency?: number };

type Admission = { scope: string; limits: BucketLimits; tokens: number; keyIndex: number; apiKey?: string; release: () => Promise<void> };

/** Rate-limit scope of one key of a provider's key pool (never the key itself). */
const keyScope = (provider: string, index: number) => `${provider}:key${index}`;
/** Rate-limit scope of a tenant's own key: isolated from the platform pool and from other tenants. */
const tenantScope = (provider: string, keyId: string) => `${provider}:tenant:${keyId}`;

/** Which providers a caller can use, and with whose keys. */
export type CredentialScope = { credentialProviders?: Iterable<string>; platformKeys?: boolean };

export const DEFAULT_GATEWAY_POLICY: GatewayPolicy = {
  maxRetries: 2,
  attemptTimeoutMs: 180_000,
  firstTokenTimeoutMs: 90_000,
  idleTimeoutMs: 30_000,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  maxRateLimitWaitMs: 60_000,
  defaultFallbacks: [],
  equivalentFailover: true,
  pricing: new Map(),
  providerConcurrency: {},
  providerLimits: {},
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER,
};

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export class DefaultModelGateway implements ModelGateway {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly policy: GatewayPolicy;
  private readonly sleep: Sleep;
  private readonly limiter: RateLimiter;
  private readonly now: () => number;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly roundRobin = new Map<string, number>();

  constructor(
    adapters: ProviderAdapter[],
    policy: Partial<GatewayPolicy> = {},
    opts: { sleep?: Sleep; limiter?: RateLimiter; now?: () => number } = {},
  ) {
    for (const a of adapters) this.adapters.set(a.id, a);
    this.policy = { ...DEFAULT_GATEWAY_POLICY, ...policy };
    // MODEL_PROVIDER_CONCURRENCY is folded into the provider limits.
    const limits: Record<string, ProviderLimits> = { ...this.policy.providerLimits };
    for (const [provider, n] of Object.entries(this.policy.providerConcurrency)) {
      if (n > 0) limits[provider] = { ...limits[provider], concurrency: limits[provider]?.concurrency ?? n };
    }
    this.policy.providerLimits = limits;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.limiter = opts.limiter ?? new InMemoryRateLimiter(this.now);
  }

  private breakerFor(provider: string): CircuitBreaker {
    let b = this.breakers.get(provider);
    if (!b) {
      b = new CircuitBreaker(this.policy.circuitBreaker, this.now);
      this.breakers.set(provider, b);
    }
    return b;
  }

  /** Circuit state per provider (for health views). */
  circuits(): Record<string, ReturnType<CircuitBreaker['snapshot']>> {
    return Object.fromEntries([...this.adapters.keys()].map((id) => [id, this.breakerFor(id).snapshot()]));
  }

  private pricingFor(ref: string, entry: CatalogEntry): ModelPricing | undefined {
    return this.policy.pricing.get(ref) ?? entry.pricing;
  }

  /**
   * Whose key would serve this provider for a caller: the tenant's own key when it has one (and the
   * provider takes tenant keys), else a platform key when allowed and configured; null = cannot serve.
   */
  private keySourceFor(adapter: ProviderAdapter, hasCredential: boolean, platformKeys: boolean): 'workspace' | 'platform' | null {
    if (hasCredential && adapter.acceptsCredentials && adapter.catalog().length > 0) return 'workspace';
    if (platformKeys && adapter.isAvailable()) return 'platform';
    return null;
  }

  /**
   * Models and their availability. Without a scope this is the platform view (server keys); with
   * one it is a tenant's view: providers it has keys for, plus platform keys when allowed.
   */
  listModels(scope?: CredentialScope): ModelInfo[] {
    const tenant = new Set(scope?.credentialProviders ?? []);
    const platformKeys = scope?.platformKeys ?? true;
    const out: ModelInfo[] = [];
    for (const adapter of this.adapters.values()) {
      const source = this.keySourceFor(adapter, tenant.has(adapter.id), platformKeys);
      // A key-based provider with neither a server key nor this tenant's key is offered in
      // Settings → Model providers, not as a list of models nobody here can use.
      if (source === null && adapter.acceptsCredentials && adapter.describe?.().configured === false) continue;
      for (const entry of adapter.catalog()) {
        out.push({
          ref: `${adapter.id}/${entry.model}`,
          provider: adapter.id,
          model: entry.model,
          displayName: entry.displayName,
          tier: entry.tier,
          contextWindow: entry.contextWindow,
          capabilities: { tools: entry.tools, reasoning: entry.reasoning !== 'none', streaming: true },
          supportedParameters: [
            'temperature' as const,
            'maxOutputTokens' as const,
            'jsonMode' as const,
            ...(entry.reasoning !== 'none' ? (['reasoningBudget'] as const) : []),
            ...(entry.tools ? (['tools'] as const) : []),
          ],
          available: source !== null && this.breakerFor(adapter.id).state() !== 'open',
          ...(scope && source ? { keySource: source } : {}),
          ...(this.pricingFor(`${adapter.id}/${entry.model}`, entry)
            ? { pricing: this.pricingFor(`${adapter.id}/${entry.model}`, entry) }
            : {}),
        });
      }
    }
    return out;
  }

  /** Providers with configuration, health and capability facts (no secrets). */
  listProviders(): ProviderInfo[] {
    return [...this.adapters.values()].map((a) => {
      const d = a.describe?.() ?? {
        kind: a.displayName,
        endpoint: '',
        configured: a.isAvailable(),
        fineTuning: { status: 'not_available' as const, reason: 'Fine-tuning capability unknown for this provider.' },
      };
      return {
        id: a.id,
        displayName: a.displayName,
        configured: d.configured,
        available: a.isAvailable() && this.breakerFor(a.id).state() !== 'open',
        circuit: this.breakerFor(a.id).state(),
        kind: d.kind,
        endpoint: d.endpoint,
        models: a.catalog().length,
        fineTuning: d.fineTuning,
      };
    });
  }

  /** Checks a tenant's key against its provider before it is stored. */
  async verifyCredential(provider: string, apiKey: string, signal?: AbortSignal): Promise<CredentialCheck> {
    const adapter = this.adapters.get(provider);
    if (!adapter?.acceptsCredentials || !adapter.verifyCredential) {
      return { ok: false, reason: 'rejected', message: `${adapter?.displayName ?? provider} does not accept workspace keys` };
    }
    return adapter.verifyCredential(apiKey, signal);
  }

  /** Providers that accept tenant keys (for key management screens). */
  credentialProviders(): Array<{ id: string; displayName: string; platformKey: boolean }> {
    return [...this.adapters.values()]
      .filter((a) => a.acceptsCredentials)
      .map((a) => ({ id: a.id, displayName: a.displayName, platformKey: a.isAvailable() }));
  }

  /**
   * A view of this gateway for one tenant: every call carries the tenant's keys, and listing and
   * defaults reflect what those keys (and, when allowed, platform keys) can serve.
   */
  scoped(credentials: Record<string, ProviderCredential>, opts: { platformKeys?: boolean; guard?: ModelCallGuard } = {}): ModelGateway {
    const platformKeys = opts.platformKeys ?? true;
    const guard = opts.guard ? { guard: opts.guard } : {};
    const scope: CredentialScope = { credentialProviders: Object.keys(credentials), platformKeys };
    return {
      listModels: () => this.listModels(scope),
      defaultModel: () => this.defaultModel(scope),
      complete: (request) => this.complete({ ...guard, ...request, credentials: { ...credentials, ...request.credentials }, platformKeys }),
      stream: (request) => this.stream({ ...guard, ...request, credentials: { ...credentials, ...request.credentials }, platformKeys }),
    };
  }

  defaultModel(scope?: CredentialScope): string | undefined {
    const models = this.listModels(scope);
    if (this.policy.defaultModel && models.some((m) => m.ref === this.policy.defaultModel && m.available)) {
      return this.policy.defaultModel;
    }
    return models.find((m) => m.available)?.ref ?? this.policy.defaultModel ?? models[0]?.ref;
  }

  /** Probes all adapters that support health checks. */
  async refreshHealth(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    await Promise.all(
      [...this.adapters.values()].map(async (a) => {
        result[a.id] = a.checkHealth ? await a.checkHealth() : a.isAvailable();
      }),
    );
    return result;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    let response: ModelResponse | undefined;
    for await (const ev of this.stream(request)) {
      if (ev.type === 'done') response = ev.response;
    }
    if (!response) throw new ModelError('provider_error', 'Model stream ended without a response');
    return response;
  }

  private familyOf(ref: string): string | undefined {
    try {
      const { provider, model } = parseModelRef(ref);
      return this.adapters.get(provider)?.catalog().find((e) => e.model === model)?.family;
    } catch {
      return undefined;
    }
  }

  /**
   * Provider failover: right after each model in the chain, the same model (same family) on the
   * other providers this caller can use, so an outage fails over before the model is downgraded.
   */
  private withEquivalents(chain: string[], request: Pick<ModelRequest, 'credentials' | 'platformKeys'>): string[] {
    if (!this.policy.equivalentFailover) return chain;
    const out: string[] = [];
    for (const ref of chain) {
      out.push(ref);
      const family = this.familyOf(ref);
      if (!family) continue;
      for (const adapter of this.adapters.values()) {
        const usable = this.keySourceFor(adapter, Boolean(request.credentials?.[adapter.id]), request.platformKeys ?? true) !== null;
        if (!usable) continue;
        for (const entry of adapter.catalog()) {
          if (entry.family === family) out.push(`${adapter.id}/${entry.model}`);
        }
      }
    }
    return dedupe(out);
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const chain = this.withEquivalents(dedupe([request.model, ...(request.fallbacks ?? this.policy.defaultFallbacks)]), request);
    const started = Date.now();
    let totalAttempts = 0;
    let lastError: ModelError | undefined;

    for (let i = 0; i < chain.length; i++) {
      const ref = chain[i]!;
      if (i > 0) {
        const sameModel = this.familyOf(chain[i - 1]!) !== undefined && this.familyOf(chain[i - 1]!) === this.familyOf(ref);
        yield { type: 'fallback', from: chain[i - 1]!, to: ref, reason: lastError?.message ?? 'unavailable', ...(sameModel ? { sameModel: true } : {}) };
      }
      const resolved = this.resolve(ref, request);
      if (resolved instanceof ModelError) {
        lastError = resolved;
        continue;
      }
      const { adapter, entry, model } = resolved;
      const credential = adapter.acceptsCredentials ? request.credentials?.[adapter.id] : undefined;
      // Spending limits and similar policy: a refused model is skipped like an unavailable one.
      if (request.guard) {
        const refused = await request.guard({ provider: adapter.id, ref, ...(credential ? { keyId: credential.keyId } : {}) });
        if (refused) {
          lastError = refused;
          continue;
        }
      }
      const breaker = this.breakerFor(adapter.id);

      for (let attempt = 1; attempt <= this.policy.maxRetries + 1; attempt++) {
        throwIfAborted(request.signal);
        // Circuit breaker: a provider that keeps failing is skipped without spending a request.
        if (!breaker.tryAcquire()) {
          const snap = breaker.snapshot();
          lastError = new ModelError('unavailable', `${adapter.displayName} is temporarily skipped after repeated failures (circuit open${snap.retryAt ? ` until ${snap.retryAt}` : ''})`);
          break;
        }

        // Budget-aware admission: wait for provider capacity (shared across all workers) instead
        // of sending a request that would be rejected. Too long a wait → try the next model.
        let admission: Admission;
        try {
          admission = yield* this.admit(adapter, ref, request);
        } catch (err) {
          breaker.onNeutral();
          const error = toModelError(err, request.signal);
          if (error.code === 'cancelled') throw error;
          lastError = error;
          break;
        }

        totalAttempts++;
        yield { type: 'attempt', ref, provider: adapter.id, model, attempt };

        let producedOutput = false;
        try {
          const result = yield* this.runAttempt(adapter, entry, model, request, admission, () => {
            producedOutput = true;
          });
          breaker.onSuccess();
          // Correct the reservation with what the provider actually counted.
          const actual = result.usage?.totalTokens;
          if (actual !== undefined) void this.limiter.adjust(admission.scope, admission.limits, actual - admission.tokens).catch(() => {});
          const costUsd = estimateCostUsd(result.usage, this.pricingFor(ref, entry));
          yield {
            type: 'done',
            response: {
              ...result,
              ...(result.usage && costUsd !== undefined ? { usage: { ...result.usage, costUsd } } : {}),
              provider: adapter.id,
              model,
              ref,
              latencyMs: Date.now() - started,
              attempts: totalAttempts,
              ...(i > 0 ? { fallbackFrom: chain[0] } : {}),
              ...(credential ? { keyId: credential.keyId } : {}),
            },
          };
          return;
        } catch (err) {
          const error = toModelError(err, request.signal);
          if (PROVIDER_HEALTH_FAILURES.has(error.code)) breaker.onFailure();
          else breaker.onNeutral();
          if (error.code === 'cancelled') throw error;
          if (producedOutput) {
            // Output already reached the caller: retrying would duplicate it.
            throw new ModelError('interrupted', `Stream interrupted: ${error.message}`, {
              retryable: false,
              cause: error,
            });
          }
          // Nothing was produced: give the reservation back. A provider rate limit also tells
          // every worker sharing this key to hold off until the provider says so.
          void this.limiter.adjust(admission.scope, admission.limits, -admission.tokens).catch(() => {});
          if (error.code === 'rate_limited' && error.retryAfterMs !== undefined) {
            void this.limiter.block(admission.scope, error.retryAfterMs).catch(() => {});
          }
          lastError = error;
          if (!error.retryable || attempt > this.policy.maxRetries) break;
          const delayMs = this.backoff(attempt, error.retryAfterMs, error.code);
          yield { type: 'retry', ref, attempt, reason: error.message, delayMs };
          // A blocked key is waited for by the next admission (or another key is used), so a
          // rate-limited attempt does not sleep here.
          if (!(error.code === 'rate_limited' && error.retryAfterMs !== undefined)) {
            await this.sleep(delayMs, request.signal).catch(() => {
              throw new ModelError('cancelled', 'Model call cancelled');
            });
          }
        } finally {
          await admission.release().catch(() => {});
        }
      }
    }
    throw lastError ?? new ModelError('unavailable', 'No model available');
  }

  /**
   * Reserves provider budget for one attempt: tokens and requests per minute on one key of the
   * provider's key pool (round-robin, first key with capacity wins), then a concurrency slot.
   * Waits for capacity up to `maxRateLimitWaitMs`; beyond that it fails with `rate_limited` so the
   * caller falls back to another model rather than queueing indefinitely.
   */
  private async *admit(adapter: ProviderAdapter, ref: string, request: ModelRequest): AsyncGenerator<ModelEvent, Admission> {
    // A tenant's own key: its own scope, honouring the provider's retry-after for that key only.
    // Platform budgets and concurrency slots protect platform keys and do not apply.
    const credential = request.credentials?.[adapter.id];
    if (credential && adapter.acceptsCredentials) {
      const scope = tenantScope(adapter.id, credential.keyId);
      const deadline = this.now() + this.policy.maxRateLimitWaitMs;
      for (;;) {
        throwIfAborted(request.signal);
        const r = await this.limiter.reserve(scope, {}, 0);
        if (r.waitMs === 0) break;
        if (this.now() + r.waitMs > deadline) {
          throw new ModelError('rate_limited', `${adapter.displayName} is rate limiting this workspace's key (capacity returns in ~${Math.ceil(r.waitMs / 1000)}s)`, {
            retryAfterMs: r.waitMs,
          });
        }
        yield { type: 'throttled', ref, provider: adapter.id, waitMs: r.waitMs, reason: "Waiting for the workspace key's provider rate limit" };
        await this.sleep(r.waitMs, request.signal).catch(() => {
          throw new ModelError('cancelled', 'Model call cancelled');
        });
      }
      return { scope, limits: {}, tokens: 0, keyIndex: 0, apiKey: credential.apiKey, release: async () => {} };
    }
    const limits = this.policy.providerLimits[adapter.id] ?? {};
    const buckets: BucketLimits = {
      ...(limits.tokensPerMinute ? { tokensPerMinute: limits.tokensPerMinute } : {}),
      ...(limits.requestsPerMinute ? { requestsPerMinute: limits.requestsPerMinute } : {}),
    };
    const hasBudget = Boolean(buckets.tokensPerMinute || buckets.requestsPerMinute);
    const keys = adapter.keyCount?.() ?? 1;
    const tokens = estimateRequestTokens(request);
    const deadline = this.now() + this.policy.maxRateLimitWaitMs;
    let keyIndex = 0;

    // Always consulted: even without configured budgets a key may be blocked by a provider retry-after.
    {
      const start = this.roundRobin.get(adapter.id) ?? 0;
      this.roundRobin.set(adapter.id, (start + 1) % keys);
      for (;;) {
        throwIfAborted(request.signal);
        let best = Infinity;
        let granted = -1;
        for (let k = 0; k < keys; k++) {
          const idx = (start + k) % keys;
          const r = await this.limiter.reserve(keyScope(adapter.id, idx), buckets, tokens);
          if (r.waitMs === 0) {
            granted = idx;
            break;
          }
          best = Math.min(best, r.waitMs);
        }
        if (granted >= 0) {
          keyIndex = granted;
          break;
        }
        if (this.now() + best > deadline) {
          throw new ModelError('rate_limited', `${adapter.displayName} budget exhausted (capacity returns in ~${Math.ceil(best / 1000)}s)`, {
            retryAfterMs: best,
          });
        }
        yield { type: 'throttled', ref, provider: adapter.id, waitMs: best, reason: 'Waiting for provider rate-limit budget' };
        await this.sleep(best, request.signal).catch(() => {
          throw new ModelError('cancelled', 'Model call cancelled');
        });
      }
    }

    let release: () => Promise<void> = async () => {};
    if (limits.concurrency) {
      const slotTtl = (request.timeoutMs ?? this.policy.attemptTimeoutMs) + 60_000;
      release = await this.limiter.acquireSlot(`${adapter.id}:concurrency`, limits.concurrency, slotTtl, request.signal);
    }
    return { scope: keyScope(adapter.id, keyIndex), limits: buckets, tokens: hasBudget ? tokens : 0, keyIndex, release };
  }

  private async *runAttempt(
    adapter: ProviderAdapter,
    entry: CatalogEntry,
    model: string,
    request: ModelRequest,
    admission: Pick<Admission, 'keyIndex' | 'apiKey'>,
    onOutput: () => void,
  ): AsyncGenerator<ModelEvent, Omit<ModelResponse, 'provider' | 'model' | 'ref' | 'latencyMs' | 'attempts'>> {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(new ModelError('cancelled', 'Model call cancelled'));
    if (request.signal?.aborted) onParentAbort();
    request.signal?.addEventListener('abort', onParentAbort, { once: true });

    const attemptTimeout = request.timeoutMs ?? this.policy.attemptTimeoutMs;
    const hardTimer = setTimeout(
      () => controller.abort(new ModelError('timeout', `Model call exceeded ${attemptTimeout}ms`)),
      attemptTimeout,
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (ms: number, what: string) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => controller.abort(new ModelError('timeout', `No ${what} from model within ${ms}ms`)),
        ms,
      );
    };
    armIdle(this.policy.firstTokenTimeoutMs, 'first output');

    const attemptStart = Date.now();
    let firstTokenMs: number | undefined;
    let text = '';
    const toolCalls: ToolCall[] = [];
    let usage: Usage | undefined;
    let finishReason: FinishReason = 'unknown';
    let providerState: ProviderState | undefined;

    try {
      const { model: _ref, fallbacks: _f, signal: _s, timeoutMs: _t, credentials: _c, platformKeys: _p, guard: _g, ...rest } = request;
      const keys = admission.apiKey ? { keyIndex: 0, apiKey: admission.apiKey } : { keyIndex: admission.keyIndex };
      for await (const ev of adapter.stream({ ...rest, model, entry, ...keys }, controller.signal)) {
        if (controller.signal.aborted) throw controller.signal.reason;
        armIdle(this.policy.idleTimeoutMs, 'output');
        switch (ev.type) {
          case 'delta':
            firstTokenMs ??= Date.now() - attemptStart;
            text += ev.text;
            onOutput();
            yield { type: 'delta', text: ev.text };
            break;
          case 'tool_call':
            firstTokenMs ??= Date.now() - attemptStart;
            toolCalls.push(ev.call);
            onOutput();
            yield { type: 'tool_call', call: ev.call };
            break;
          case 'usage':
            usage = ev.usage;
            break;
          case 'state':
            providerState = ev.state;
            break;
          case 'finish':
            finishReason = ev.reason;
            break;
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      return { text, toolCalls, usage, finishReason, firstTokenMs, ...(providerState ? { providerState } : {}) };
    } catch (err) {
      // Prefer the abort reason (timeout/cancel) over the generic AbortError thrown by fetch.
      if (controller.signal.aborted && controller.signal.reason instanceof ModelError) {
        throw controller.signal.reason;
      }
      throw err;
    } finally {
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      request.signal?.removeEventListener('abort', onParentAbort);
    }
  }

  private resolve(ref: string, request: Pick<ModelRequest, 'credentials' | 'platformKeys'> = {}): { adapter: ProviderAdapter; entry: CatalogEntry; model: string } | ModelError {
    let parsed: { provider: string; model: string };
    try {
      parsed = parseModelRef(ref);
    } catch {
      return new ModelError('bad_request', `Invalid model reference "${ref}"`, { retryable: false });
    }
    const adapter = this.adapters.get(parsed.provider);
    if (!adapter) return new ModelError('model_not_found', `Unknown provider "${parsed.provider}"`);
    const entry = adapter.catalog().find((e) => e.model === parsed.model);
    if (!entry) return new ModelError('model_not_found', `Model "${ref}" is not enabled`);
    const hasCredential = Boolean(request.credentials?.[adapter.id]);
    if (this.keySourceFor(adapter, hasCredential, request.platformKeys ?? true) === null) {
      if (request.platformKeys === false && adapter.acceptsCredentials) {
        return new ModelError('auth', `No API key for ${adapter.displayName}: add one in Settings, Provider keys`, { retryable: false });
      }
      return new ModelError('unavailable', `Provider "${adapter.displayName}" is not configured or unreachable`);
    }
    return { adapter, entry, model: parsed.model };
  }

  private backoff(attempt: number, retryAfterMs?: number, code?: string): number {
    // A rate-limited provider that says when capacity returns is worth waiting for (bounded):
    // falling back early would downgrade the model for a few seconds of quota.
    if (retryAfterMs !== undefined && code === 'rate_limited') return Math.min(retryAfterMs + 250, this.policy.maxRateLimitWaitMs);
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, this.policy.maxBackoffMs);
    const exp = this.policy.baseBackoffMs * 2 ** (attempt - 1);
    const jitter = Math.random() * this.policy.baseBackoffMs;
    return Math.min(exp + jitter, this.policy.maxBackoffMs);
  }
}

function toModelError(err: unknown, parentSignal?: AbortSignal): ModelError {
  if (err instanceof ModelError) return err;
  if (parentSignal?.aborted) return new ModelError('cancelled', 'Model call cancelled');
  if (isAbortError(err)) return new ModelError('timeout', 'Model call aborted');
  return new ModelError('provider_error', err instanceof Error ? err.message : String(err), { cause: err });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ModelError('cancelled', 'Model call cancelled');
}

function dedupe(refs: string[]): string[] {
  return [...new Set(refs.filter(Boolean))];
}
