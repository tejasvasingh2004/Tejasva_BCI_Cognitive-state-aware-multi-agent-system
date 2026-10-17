import { z } from 'zod';

export const RunMode = z.enum(['standard', 'cognitive']);
export type RunMode = z.infer<typeof RunMode>;

export const RunStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatus>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Resolved agent topology. `auto` is only valid in requests; plans always hold a concrete value. */
export const AgentStrategy = z.enum([
  'direct',
  'single_agent',
  'sequential',
  'parallel',
  'supervisor',
  'evaluator_optimizer',
]);
export type AgentStrategy = z.infer<typeof AgentStrategy>;

export const RequestedAgentStrategy = z.union([AgentStrategy, z.literal('auto')]);
export type RequestedAgentStrategy = z.infer<typeof RequestedAgentStrategy>;

export const ModelStrategy = z.enum(['single', 'multi']);
export type ModelStrategy = z.infer<typeof ModelStrategy>;

export const RequestedModelStrategy = z.union([ModelStrategy, z.literal('auto')]);
export type RequestedModelStrategy = z.infer<typeof RequestedModelStrategy>;

/** Provider-independent reasoning control. The Model Gateway maps it to provider features. */
export const ReasoningBudget = z.enum(['off', 'low', 'medium', 'high']);
export type ReasoningBudget = z.infer<typeof ReasoningBudget>;

export const Density = z.enum(['low', 'medium', 'high']);
export type Density = z.infer<typeof Density>;

export const ApiErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'quota_exceeded',
  'overloaded',
  'unavailable',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    retryable: z.boolean().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
