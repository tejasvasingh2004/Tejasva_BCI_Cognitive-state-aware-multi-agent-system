export type CircuitState = 'closed' | 'open' | 'half_open';

export type CircuitBreakerOptions = {
  /** Consecutive provider failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before a single trial request is allowed. */
  openMs: number;
  /** Upper bound for the open period, which doubles after each failed trial. */
  maxOpenMs: number;
};

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerOptions = { failureThreshold: 5, openMs: 30_000, maxOpenMs: 5 * 60_000 };

/**
 * Per-provider circuit breaker. While open, calls to the provider are skipped immediately (the
 * gateway moves on to the next model in the fallback chain) instead of every request paying for
 * timeouts and retries against a provider that is down. After the open period one trial request
 * is let through (half-open): success closes the circuit, failure re-opens it for longer.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private openFor: number;
  private probing = false;
  private opened = false;

  constructor(
    private readonly opts: CircuitBreakerOptions = DEFAULT_CIRCUIT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {
    this.openFor = opts.openMs;
  }

  state(): CircuitState {
    if (!this.opened) return 'closed';
    return this.now() >= this.openUntil ? 'half_open' : 'open';
  }

  /** Whether a request may be sent now. In half-open state only one trial request is allowed. */
  tryAcquire(): boolean {
    const s = this.state();
    if (s === 'closed') return true;
    if (s === 'open' || this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.opened = false;
    this.probing = false;
    this.openFor = this.opts.openMs;
  }

  onFailure(): void {
    if (this.probing) {
      // The trial failed: stay open, and back off for longer.
      this.probing = false;
      this.openFor = Math.min(this.openFor * 2, this.opts.maxOpenMs);
      this.openUntil = this.now() + this.openFor;
      return;
    }
    this.failures++;
    if (!this.opened && this.failures >= this.opts.failureThreshold) {
      this.opened = true;
      this.openUntil = this.now() + this.openFor;
    }
  }

  /** The request ended for a reason that says nothing about provider health (cancelled, rate-limited…). */
  onNeutral(): void {
    this.probing = false;
  }

  snapshot(): { state: CircuitState; failures: number; retryAt?: string } {
    const state = this.state();
    return { state, failures: this.failures, ...(state === 'open' ? { retryAt: new Date(this.openUntil).toISOString() } : {}) };
  }
}

/** Error codes that indicate the provider itself is unhealthy (count towards opening the circuit). */
export const PROVIDER_HEALTH_FAILURES = new Set(['unavailable', 'timeout', 'provider_error', 'interrupted']);
