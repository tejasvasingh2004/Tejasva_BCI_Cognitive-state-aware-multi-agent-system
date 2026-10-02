export type ModelErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'bad_request'
  | 'cancelled'
  | 'model_not_found'
  | 'provider_error'
  | 'interrupted';

const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set(['timeout', 'rate_limited', 'unavailable', 'provider_error']);

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: ModelErrorCode,
    message: string,
    opts: { status?: number; retryAfterMs?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ModelError';
    this.code = code;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
  }
}

export function httpStatusToError(status: number, body: string, retryAfter?: string | null): ModelError {
  const msg = summarizeProviderError(body) || `HTTP ${status}`;
  const retryAfterMs = parseRetryAfter(retryAfter) ?? (status === 429 ? retryHintFromMessage(msg) : undefined);
  if (status === 401 || status === 403) return new ModelError('auth', `Provider rejected credentials: ${msg}`, { status });
  if (status === 404) return new ModelError('model_not_found', msg, { status });
  if (status === 408) return new ModelError('timeout', msg, { status });
  if (status === 429) return new ModelError('rate_limited', msg, { status, retryAfterMs });
  if (status >= 500) return new ModelError('unavailable', msg, { status, retryAfterMs });
  return new ModelError('bad_request', msg, { status });
}

function summarizeProviderError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const raw = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
    if (raw) return raw.slice(0, 300);
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}

/** Providers such as Groq also state the wait in the message: "Please try again in 39.12s" / "in 450ms". */
function retryHintFromMessage(msg: string): number | undefined {
  const m = /try again in (?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)\b/i.exec(msg);
  if (!m) return undefined;
  const value = Number(m[2]) * (m[3] === 'ms' ? 1 : 1000) + Number(m[1] ?? 0) * 60_000;
  return Number.isFinite(value) ? value : undefined;
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
