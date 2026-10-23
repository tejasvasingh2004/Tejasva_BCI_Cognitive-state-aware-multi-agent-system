import { ModelError } from './errors';

export type AdaptiveLimitOptions = {
  initial?: number;
  min?: number;
  max?: number;
  /** How far the short-term latency may exceed the long-term baseline before the limit shrinks. */
  tolerance?: number;
  /** Weight of each new limit estimate (0..1). */
  smoothing?: number;
};

export type AdaptiveLimitSnapshot = { limit: number; inflight: number; waiting: number; shortRttMs: number | null; longRttMs: number | null };

/**
 * A concurrency limit that adapts to measured latency (after Netflix's Gradient2 limiter): while
 * the short-term latency stays near its long-term baseline the limit grows (by about √limit per
 * sample); when latency climbs — requests are queueing at the provider — it shrinks in proportion;
 * on overload signals (rate limits, 5xx, timeouts) it backs off multiplicatively. Calls beyond the
 * limit wait their turn instead of piling onto a struggling provider.
 */
export class AdaptiveLimit {
  private limitValue: number;
  private inflightCount = 0;
  private readonly waiters: Array<() => void> = [];
  private shortRtt: number | null = null;
  private longRtt: number | null = null;
  private readonly min: number;
  private readonly max: number;
  private readonly tolerance: number;
  private readonly smoothing: number;

  constructor(opts: AdaptiveLimitOptions = {}) {
    this.min = opts.min ?? 2;
    this.max = opts.max ?? 256;
    this.limitValue = Math.min(this.max, Math.max(this.min, opts.initial ?? 32));
    this.tolerance = opts.tolerance ?? 2;
    this.smoothing = opts.smoothing ?? 0.2;
  }

  get limit(): number {
    return Math.floor(this.limitValue);
  }

  snapshot(): AdaptiveLimitSnapshot {
    return {
      limit: this.limit,
      inflight: this.inflightCount,
      waiting: this.waiters.length,
      shortRttMs: this.shortRtt === null ? null : Math.round(this.shortRtt),
      longRttMs: this.longRtt === null ? null : Math.round(this.longRtt),
    };
  }

  /**
   * Waits for a slot (at most `maxWaitMs`; then `rate_limited`, so the caller can fall back) and
   * returns the release function, which takes the outcome sample.
   */
  async acquire(signal?: AbortSignal, maxWaitMs = 60_000, onWait?: () => void): Promise<(sample: { rttMs?: number; overloaded?: boolean }) => void> {
    if (this.inflightCount < this.limit) {
      this.inflightCount++;
    } else {
      onWait?.();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          remove();
          reject(new ModelError('rate_limited', `Provider concurrency limit (${this.limit}) reached; waited ${Math.round(maxWaitMs / 1000)}s`, { retryAfterMs: 1_000 }));
        }, maxWaitMs);
        const onAbort = () => {
          remove();
          reject(new ModelError('cancelled', 'Model call cancelled'));
        };
        // The releaser hands its slot over: inflight is incremented here, before this caller resumes.
        const wake = () => {
          this.inflightCount++;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const remove = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(wake);
      });
    }
    let released = false;
    return (sample) => {
      if (released) return;
      released = true;
      this.inflightCount--;
      this.update(sample);
      this.wakeWaiters();
    };
  }

  private wakeWaiters() {
    while (this.waiters.length > 0 && this.inflightCount < this.limit) this.waiters.shift()!();
  }

  /** Feeds one outcome: a latency sample and/or an overload signal. */
  update(sample: { rttMs?: number; overloaded?: boolean }) {
    if (sample.overloaded) {
      this.limitValue = Math.max(this.min, this.limitValue * 0.75);
      return;
    }
    const rtt = sample.rttMs;
    if (rtt === undefined || !(rtt >= 0)) return;
    this.shortRtt = this.shortRtt === null ? rtt : this.shortRtt * 0.6 + rtt * 0.4;
    this.longRtt = this.longRtt === null ? rtt : this.longRtt * 0.98 + rtt * 0.02;
    // Latency improved a lot: let the baseline follow so the limit is not stuck high.
    if (this.longRtt > this.shortRtt * 2) this.longRtt *= 0.95;
    const gradient = Math.max(0.5, Math.min(1, (this.tolerance * this.longRtt) / Math.max(1, this.shortRtt)));
    const estimate = this.limitValue * gradient + Math.sqrt(this.limitValue);
    this.limitValue = Math.min(this.max, Math.max(this.min, (1 - this.smoothing) * this.limitValue + this.smoothing * estimate));
  }
}

/** Parses provider reset durations such as `"2m59.56s"`, `"7.66s"`, `"450ms"` or `"1h"` into ms. */
export function parseResetDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(v);
  if (!m || v === '') return undefined;
  const [, h, min, s, ms] = m;
  const total = Number(h ?? 0) * 3_600_000 + Number(min ?? 0) * 60_000 + Number(s ?? 0) * 1000 + Number(ms ?? 0);
  return Number.isFinite(total) ? total : undefined;
}
