import { ModelError } from '@neuroflow/models';

export class RunCancelledError extends Error {
  constructor(message = 'Run cancelled') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

export class BudgetExceededError extends Error {
  constructor(readonly budget: string) {
    super(`Run exceeded its ${budget} budget`);
    this.name = 'BudgetExceededError';
  }
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

/**
 * Maps internal errors to a user-safe code/message. Infrastructure details (URLs, stack traces,
 * provider payloads) are never exposed.
 */
export function toRunError(err: unknown, stage?: string): { code: string; message: string; stage?: string } {
  const base = stage ? { stage } : {};
  if (err instanceof RunCancelledError) return { code: 'cancelled', message: 'Run cancelled', ...base };
  if (err instanceof BudgetExceededError) {
    return { code: 'budget_exceeded', message: `The task exceeded its ${err.budget} limit and was stopped.`, ...base };
  }
  if (err instanceof RoutingError) return { code: 'no_model', message: err.message, ...base };
  if (err instanceof ModelError) {
    const messages: Record<string, string> = {
      timeout: 'The model took too long to respond.',
      rate_limited: 'The model provider is rate limiting requests. Please retry shortly.',
      unavailable: 'The model provider is unavailable right now. Try again or choose another model.',
      auth: 'The model provider rejected the configured credentials.',
      bad_request: 'The model provider rejected the request.',
      model_not_found: 'The selected model is not available.',
      interrupted: 'The model stream was interrupted.',
      provider_error: 'The model provider returned an error.',
      cancelled: 'Run cancelled',
    };
    return { code: `model_${err.code}`, message: messages[err.code] ?? 'The model call failed.', ...base };
  }
  return { code: 'internal', message: 'NeuroFlow hit an unexpected error while executing this task.', ...base };
}
