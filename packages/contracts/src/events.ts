import { z } from 'zod';
import { RiskLevel, ToolErrorCode, ToolResultStatus } from './tools';
import { Usage } from './messages';
import { ExecutionPlan, RunError } from './runs';
import { CognitivePolicy, CognitiveState } from './cognitive';

/**
 * Realtime execution events. Every event originates from real backend execution and is persisted
 * (response deltas are coalesced before persistence). Events never contain hidden reasoning.
 */
export const RunEventData = {
  'run.created': z.object({ mode: z.string() }),
  'run.queued': z.object({}),
  'run.started': z.object({ attempt: z.number().int(), queueLatencyMs: z.number().nonnegative() }),
  'router.started': z.object({}),
  'router.selected': z.object({ plan: ExecutionPlan }),
  'cognitive.applied': z.object({
    available: z.boolean(),
    state: CognitiveState.optional(),
    policy: CognitivePolicy.optional(),
    reason: z.string().optional(),
  }),
  'context.built': z.object({
    agentExecutionId: z.string().optional(),
    sources: z.array(
      z.object({ kind: z.string(), items: z.number().int(), tokens: z.number().int() }),
    ),
    totalTokens: z.number().int(),
    droppedMessages: z.number().int(),
  }),
  'agent.started': z.object({
    agentExecutionId: z.string(),
    agentId: z.string(),
    name: z.string(),
    role: z.string(),
    model: z.string(),
  }),
  'agent.completed': z.object({
    agentExecutionId: z.string(),
    agentId: z.string(),
    status: z.enum(['completed', 'failed', 'cancelled']),
    durationMs: z.number().nonnegative(),
    error: z.string().optional(),
  }),
  'model.started': z.object({
    callId: z.string(),
    agentExecutionId: z.string().optional(),
    role: z.string(),
    provider: z.string(),
    model: z.string(),
  }),
  'model.retry': z.object({
    callId: z.string(),
    attempt: z.number().int(),
    reason: z.string(),
    delayMs: z.number().nonnegative(),
  }),
  'model.fallback': z.object({
    callId: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  }),
  'model.completed': z.object({
    callId: z.string(),
    provider: z.string(),
    model: z.string(),
    status: z.enum(['completed', 'failed', 'cancelled']),
    latencyMs: z.number().nonnegative(),
    firstTokenMs: z.number().nonnegative().optional(),
    usage: Usage.optional(),
    finishReason: z.string().optional(),
    attempts: z.number().int(),
    error: z.string().optional(),
  }),
  'tool.started': z.object({
    toolCallId: z.string(),
    name: z.string(),
    agentExecutionId: z.string().optional(),
    riskLevel: RiskLevel.optional(),
  }),
  'approval.requested': z.object({
    toolCallId: z.string(),
    name: z.string(),
    riskLevel: RiskLevel,
    arguments: z.unknown(),
    expiresAt: z.string(),
  }),
  'approval.resolved': z.object({
    toolCallId: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
  }),
  'tool.completed': z.object({
    toolCallId: z.string(),
    name: z.string(),
    status: ToolResultStatus,
    durationMs: z.number().nonnegative(),
    errorCode: ToolErrorCode.optional(),
    summary: z.string().optional(),
  }),
  'memory.started': z.object({ query: z.string() }),
  'memory.completed': z.object({
    query: z.string(),
    count: z.number().int(),
    memoryIds: z.array(z.string()),
  }),
  'evaluation.started': z.object({ kind: z.string(), iteration: z.number().int() }),
  'evaluation.completed': z.object({
    kind: z.string(),
    iteration: z.number().int(),
    verdict: z.enum(['passed', 'failed', 'needs_refinement']),
    score: z.number().min(0).max(1).optional(),
    issues: z.array(z.string()),
  }),
  'response.delta': z.object({ text: z.string() }),
  'response.reset': z.object({ reason: z.string() }),
  'run.completed': z.object({ durationMs: z.number().nonnegative(), usage: Usage.optional() }),
  'run.failed': z.object({ error: RunError }),
  'run.cancelled': z.object({ reason: z.string() }),
} as const;

export type RunEventType = keyof typeof RunEventData;
export type RunEventPayload<T extends RunEventType> = z.infer<(typeof RunEventData)[T]>;

export const RUN_EVENT_TYPES = Object.keys(RunEventData) as RunEventType[];
export const TERMINAL_EVENT_TYPES: readonly RunEventType[] = [
  'run.completed',
  'run.failed',
  'run.cancelled',
];

export type RunEvent = {
  [T in RunEventType]: {
    runId: string;
    seq: number;
    ts: string;
    type: T;
    data: RunEventPayload<T>;
  };
}[RunEventType];

export type RunEventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

export function isTerminalEvent(event: Pick<RunEvent, 'type'>): boolean {
  return TERMINAL_EVENT_TYPES.includes(event.type);
}

export const RunEventEnvelope = z.object({
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.enum(RUN_EVENT_TYPES as [RunEventType, ...RunEventType[]]),
  data: z.unknown(),
});

/** Validates an event envelope and its type-specific payload. */
export function parseRunEvent(input: unknown): RunEvent {
  const env = RunEventEnvelope.parse(input);
  const data = RunEventData[env.type].parse(env.data);
  return { ...env, data } as RunEvent;
}
