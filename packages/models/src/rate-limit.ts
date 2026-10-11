import { ModelError } from './errors';

/** Per-minute budgets of one scope (a provider API key, or an HTTP route for one tenant). */
export type BucketLimits = { tokensPerMinute?: number; requestsPerMinute?: number };

export type Reservation = {
  /** 0 when granted; otherwise milliseconds until enough capacity (nothing was taken). */
  waitMs: number;
  remainingTokens?: number;
  remainingRequests?: number;
};

/**
 * Token-bucket rate limiter. Each scope has a token bucket and a request bucket that refill
 * continuously (capacity = the per-minute limit), plus an optional "blocked until" set from a
 * provider's own retry-after. Implementations must make `reserve` atomic so that concurrent
 * callers (many workers) never over-commit a budget.
 */
export interface RateLimiter {
  /** Takes `tokens` and one request if both buckets have capacity; otherwise takes nothing. */
  reserve(scope: string, limits: BucketLimits, tokens: number): Promise<Reservation>;
  /** Corrects the token bucket after the fact (positive = used more than reserved; negative = refund). */
  adjust(scope: string, limits: BucketLimits, tokensDelta: number): Promise<void>;
  /** The provider said "retry after": nothing is granted for this scope until then. */
  block(scope: string, ms: number): Promise<void>;
  /** Concurrency slot shared by everyone using this limiter; resolves with a release function. */
  acquireSlot(scope: string, limit: number, ttlMs: number, signal?: AbortSignal): Promise<() => Promise<void>>;
}

type Bucket = { tokens: number; requests: number; ts: number; blockedUntil: number };

/**
 * Single-process limiter (tests, local development, one worker). Same semantics as the Redis
 * implementation in @neuroflow/bus, which shares budgets across every API server and worker.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(private readonly now: () => number = Date.now) {}

  private refill(scope: string, limits: BucketLimits): Bucket {
    const now = this.now();
    const tpm = limits.tokensPerMinute ?? 0;
    const rpm = limits.requestsPerMinute ?? 0;
    const b = this.buckets.get(scope) ?? { tokens: tpm, requests: rpm, ts: now, blockedUntil: 0 };
    const elapsed = Math.max(0, now - b.ts);
    if (tpm > 0) b.tokens = Math.min(tpm, b.tokens + (elapsed * tpm) / 60_000);
    if (rpm > 0) b.requests = Math.min(rpm, b.requests + (elapsed * rpm) / 60_000);
    b.ts = now;
    this.buckets.set(scope, b);
    return b;
  }

  async reserve(scope: string, limits: BucketLimits, tokens: number): Promise<Reservation> {
    const b = this.refill(scope, limits);
    const now = this.now();
    if (b.blockedUntil > now) return { waitMs: b.blockedUntil - now };
    const tpm = limits.tokensPerMinute ?? 0;
    const rpm = limits.requestsPerMinute ?? 0;
    // A single request larger than the whole budget is admitted when the bucket is full.
    const cost = tpm > 0 ? Math.min(tokens, tpm) : 0;
    let waitMs = 0;
    if (tpm > 0 && b.tokens < cost) waitMs = Math.max(waitMs, Math.ceil(((cost - b.tokens) * 60_000) / tpm));
    if (rpm > 0 && b.requests < 1) waitMs = Math.max(waitMs, Math.ceil(((1 - b.requests) * 60_000) / rpm));
    if (waitMs > 0) return { waitMs };
    if (tpm > 0) b.tokens -= cost;
    if (rpm > 0) b.requests -= 1;
    return {
      waitMs: 0,
      ...(tpm > 0 ? { remainingTokens: Math.floor(b.tokens) } : {}),
      ...(rpm > 0 ? { remainingRequests: Math.floor(b.requests) } : {}),
    };
  }

  async adjust(scope: string, limits: BucketLimits, tokensDelta: number): Promise<void> {
    const tpm = limits.tokensPerMinute ?? 0;
    if (tpm <= 0 || tokensDelta === 0) return;
    const b = this.refill(scope, limits);
    b.tokens = Math.min(tpm, b.tokens - tokensDelta);
  }

  async block(scope: string, ms: number): Promise<void> {
    const b = this.buckets.get(scope) ?? { tokens: 0, requests: 0, ts: this.now(), blockedUntil: 0 };
    b.blockedUntil = Math.max(b.blockedUntil, this.now() + ms);
    this.buckets.set(scope, b);
  }

  async acquireSlot(scope: string, limit: number, _ttlMs: number, signal?: AbortSignal): Promise<() => Promise<void>> {
    let sem = this.semaphores.get(scope);
    if (!sem) {
      sem = new Semaphore(limit);
      this.semaphores.set(scope, sem);
    }
    const release = await sem.acquire(signal);
    return async () => release();
  }
}

/** FIFO counting semaphore; waiting respects cancellation. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const i = this.waiters.indexOf(grant);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new ModelError('cancelled', 'Model call cancelled'));
        };
        const grant = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(grant);
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** Rough token estimate of a request (≈4 characters per token) used to reserve budget up front. */
export function estimateRequestTokens(input: { messages: Array<{ content: string; toolCalls?: unknown }>; tools?: unknown[]; maxOutputTokens?: number }): number {
  let chars = 0;
  for (const m of input.messages) chars += m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) + 16;
  if (input.tools?.length) chars += JSON.stringify(input.tools).length;
  // Reserve a modest share for the answer; the bucket is corrected with real usage afterwards.
  return Math.ceil(chars / 4) + Math.min(input.maxOutputTokens ?? 512, 1024);
}
