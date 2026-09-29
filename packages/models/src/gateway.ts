import { parseModelRef, type ModelInfo, type ToolCall, type Usage } from '@neuroflow/contracts';
import { ModelError, isAbortError } from './errors';
import type {
  CatalogEntry,
  FinishReason,
  ModelEvent,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ProviderAdapter,
} from './types';

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
  /** Default fallback chain applied when a request does not specify one. */
  defaultFallbacks: string[];
  defaultModel?: string;
};

export const DEFAULT_GATEWAY_POLICY: GatewayPolicy = {
  maxRetries: 2,
  attemptTimeoutMs: 180_000,
  firstTokenTimeoutMs: 90_000,
  idleTimeoutMs: 30_000,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  defaultFallbacks: [],
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

  constructor(adapters: ProviderAdapter[], policy: Partial<GatewayPolicy> = {}, opts: { sleep?: Sleep } = {}) {
    for (const a of adapters) this.adapters.set(a.id, a);
    this.policy = { ...DEFAULT_GATEWAY_POLICY, ...policy };
    this.sleep = opts.sleep ?? defaultSleep;
  }

  listModels(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const adapter of this.adapters.values()) {
      for (const entry of adapter.catalog()) {
        out.push({
          ref: `${adapter.id}/${entry.model}`,
          provider: adapter.id,
          model: entry.model,
          displayName: entry.displayName,
          tier: entry.tier,
          contextWindow: entry.contextWindow,
          capabilities: { tools: entry.tools, reasoning: entry.reasoning !== 'none', streaming: true },
          available: adapter.isAvailable(),
        });
      }
    }
    return out;
  }

  defaultModel(): string | undefined {
    const models = this.listModels();
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

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const chain = dedupe([request.model, ...(request.fallbacks ?? this.policy.defaultFallbacks)]);
    const started = Date.now();
    let totalAttempts = 0;
    let lastError: ModelError | undefined;

    for (let i = 0; i < chain.length; i++) {
      const ref = chain[i]!;
      if (i > 0) {
        yield { type: 'fallback', from: chain[i - 1]!, to: ref, reason: lastError?.message ?? 'unavailable' };
      }
      const resolved = this.resolve(ref);
      if (resolved instanceof ModelError) {
        lastError = resolved;
        continue;
      }
      const { adapter, entry, model } = resolved;

      for (let attempt = 1; attempt <= this.policy.maxRetries + 1; attempt++) {
        throwIfAborted(request.signal);
        totalAttempts++;
        yield { type: 'attempt', ref, provider: adapter.id, model, attempt };

        let producedOutput = false;
        try {
          const result = yield* this.runAttempt(adapter, entry, model, request, () => {
            producedOutput = true;
          });
          yield {
            type: 'done',
            response: {
              ...result,
              provider: adapter.id,
              model,
              ref,
              latencyMs: Date.now() - started,
              attempts: totalAttempts,
              ...(i > 0 ? { fallbackFrom: chain[0] } : {}),
            },
          };
          return;
        } catch (err) {
          const error = toModelError(err, request.signal);
          if (error.code === 'cancelled') throw error;
          if (producedOutput) {
            // Output already reached the caller: retrying would duplicate it.
            throw new ModelError('interrupted', `Stream interrupted: ${error.message}`, {
              retryable: false,
              cause: error,
            });
          }
          lastError = error;
          if (!error.retryable || attempt > this.policy.maxRetries) break;
          const delayMs = this.backoff(attempt, error.retryAfterMs);
          yield { type: 'retry', ref, attempt, reason: error.message, delayMs };
          await this.sleep(delayMs, request.signal).catch(() => {
            throw new ModelError('cancelled', 'Model call cancelled');
          });
        }
      }
    }
    throw lastError ?? new ModelError('unavailable', 'No model available');
  }

  private async *runAttempt(
    adapter: ProviderAdapter,
    entry: CatalogEntry,
    model: string,
    request: ModelRequest,
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

    try {
      const { model: _ref, fallbacks: _f, signal: _s, timeoutMs: _t, ...rest } = request;
      for await (const ev of adapter.stream({ ...rest, model, entry }, controller.signal)) {
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
          case 'finish':
            finishReason = ev.reason;
            break;
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      return { text, toolCalls, usage, finishReason, firstTokenMs };
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

  private resolve(ref: string): { adapter: ProviderAdapter; entry: CatalogEntry; model: string } | ModelError {
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
    if (!adapter.isAvailable()) {
      return new ModelError('unavailable', `Provider "${adapter.displayName}" is not configured or unreachable`);
    }
    return { adapter, entry, model: parsed.model };
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
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
