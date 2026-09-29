import type { ApiErrorCode } from '@neuroflow/contracts';

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  overloaded: 503,
  unavailable: 503,
  internal: 500,
};

/** Errors that map directly onto the public API error contract. */
export class HttpError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.statusCode = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new HttpError('not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to perform this action') => new HttpError('forbidden', msg);
