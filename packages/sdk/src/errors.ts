/** An error answered by the NeuroFlow API (`{ error: { code, message } }`), or a transport failure. */
export class NeuroFlowError extends Error {
  /** HTTP status; undefined for network errors and timeouts. */
  readonly status?: number;
  /** API error code, e.g. `quota_exceeded`, `rate_limited`, `not_found`; `network` or `timeout` otherwise. */
  readonly code: string;
  readonly details?: unknown;
  /** Server-suggested wait before retrying (from `Retry-After`). */
  readonly retryAfterMs?: number;
  /** The `x-request-id` of the failed request, for support. */
  readonly requestId?: string;

  constructor(message: string, opts: { status?: number; code: string; details?: unknown; retryAfterMs?: number; requestId?: string; cause?: unknown }) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'NeuroFlowError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.retryAfterMs = opts.retryAfterMs;
    this.requestId = opts.requestId;
  }

  /** Whether retrying the same request may succeed. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** A webhook whose signature or timestamp did not verify. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}
