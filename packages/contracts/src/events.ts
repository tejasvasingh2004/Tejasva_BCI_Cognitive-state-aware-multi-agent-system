import { z } from 'zod';
import { RiskLevel, ToolErrorCode, ToolResultStatus } from './tools';
import { ToolCall, Usage } from './messages';
import { ExecutionPlan, RunError } from './runs';
import { CognitivePolicy, CognitiveState } from './cognitive';
import { ApprovalMode, FileChange } from './code';

const CommandKind = z.enum(['command', 'test', 'lint', 'build', 'install']);

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
    /** Older tool results replaced by a stub to keep a long tool loop within the input budget. */
    compactedToolResults: z.number().int().optional(),
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
  /** Waiting for provider budget (rate limit or concurrency) before the request is sent. */
  'model.throttled': z.object({
    callId: z.string(),
    provider: z.string(),
    waitMs: z.number().nonnegative(),
    reason: z.string(),
  }),
  'model.hedged': z.object({ callId: z.string(), from: z.string(), to: z.string(), afterMs: z.number() }),
  'model.fallback': z.object({
    callId: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
    /** Failover to the same model on another provider (not a downgrade). */
    sameModel: z.boolean().optional(),
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
    /** Why this particular call needs approval (policy explanation). */
    reason: z.string().optional(),
    /** What will happen if approved (e.g. diff summary, command line). */
    preview: z.unknown().optional(),
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
    /** Source metadata of retrieved memories (never their content). */
    items: z
      .array(z.object({ id: z.string(), source: z.string(), tags: z.array(z.string()), createdAt: z.string() }))
      .optional(),
  }),
  'evaluation.started': z.object({ kind: z.string(), iteration: z.number().int() }),
  'evaluation.completed': z.object({
    kind: z.string(),
    iteration: z.number().int(),
    verdict: z.enum(['passed', 'failed', 'needs_refinement']),
    score: z.number().min(0).max(1).optional(),
    issues: z.array(z.string()),
  }),
  // ---- Product Phase 2: code runs (emitted in addition to the generic run lifecycle) ----
  'code.run.created': z.object({
    codeWorkspaceId: z.string(),
    repository: z.string(),
    branch: z.string(),
    approvalMode: ApprovalMode,
    baseCommit: z.string().nullable(),
  }),
  'repository.loaded': z.object({
    repository: z.string(),
    branch: z.string(),
    commit: z.string().nullable(),
    fileCount: z.number().int(),
    languages: z.array(z.string()),
    projectKind: z.string(),
    instructions: z.boolean(),
  }),
  'agent.plan.created': z.object({ steps: z.array(z.string()), summary: z.string().optional() }),
  /** Plan Review: the plan waits for the user (approve, edit, request changes or stop). */
  'plan.review_required': z.object({ planId: z.string(), steps: z.array(z.string()), summary: z.string().optional(), revision: z.number().int(), expiresAt: z.string() }),
  'plan.approved': z.object({ planId: z.string(), steps: z.array(z.string()), edited: z.boolean() }),
  'plan.rejected': z.object({ planId: z.string(), feedback: z.string().optional(), willRevise: z.boolean() }),
  'file.search.started': z.object({ query: z.string(), kind: z.string() }),
  'file.search.completed': z.object({ query: z.string(), kind: z.string(), matches: z.number().int(), files: z.array(z.string()) }),
  'file.read': z.object({ path: z.string(), startLine: z.number().int().optional(), endLine: z.number().int().optional(), bytes: z.number().int() }),
  'patch.generated': z.object({ patchId: z.string(), toolCallId: z.string(), files: z.array(FileChange), valid: z.boolean(), error: z.string().optional() }),
  'patch.review_required': z.object({ patchId: z.string(), toolCallId: z.string(), files: z.array(FileChange), diff: z.string() }),
  'patch.approved': z.object({ patchId: z.string() }),
  'patch.rejected': z.object({ patchId: z.string(), reason: z.string().optional() }),
  'file.modified': z.object({
    path: z.string(),
    op: FileChange.shape.op,
    additions: z.number().int(),
    deletions: z.number().int(),
    patchId: z.string().optional(),
  }),
  'command.started': z.object({ executionId: z.string(), command: z.string(), kind: CommandKind }),
  'command.output': z.object({ executionId: z.string(), chunk: z.string() }),
  'command.completed': z.object({
    executionId: z.string(),
    kind: CommandKind,
    exitCode: z.number().int(),
    durationMs: z.number().int(),
    timedOut: z.boolean(),
  }),
  'test.started': z.object({ executionId: z.string(), command: z.string() }),
  'test.completed': z.object({
    executionId: z.string(),
    passed: z.boolean(),
    exitCode: z.number().int(),
    durationMs: z.number().int(),
    summary: z.object({ passed: z.number().int().optional(), failed: z.number().int().optional(), total: z.number().int().optional() }).optional(),
  }),
  'git.diff.updated': z.object({ files: z.array(FileChange), additions: z.number().int(), deletions: z.number().int() }),
  'branch.created': z.object({ branch: z.string(), from: z.string() }),
  'commit.created': z.object({ sha: z.string(), branch: z.string(), message: z.string(), files: z.number().int() }),
  'push.completed': z.object({ branch: z.string(), remote: z.string(), sha: z.string() }),
  'pull_request.created': z.object({ number: z.number().int(), url: z.string(), title: z.string(), head: z.string(), base: z.string() }),
  'code.run.completed': z.object({
    status: z.enum(['completed', 'failed', 'cancelled']),
    filesChanged: z.number().int(),
    additions: z.number().int(),
    deletions: z.number().int(),
    testsPassed: z.boolean().nullable(),
  }),
  'response.delta': z.object({ text: z.string() }),
  'response.reset': z.object({ reason: z.string() }),
  'run.completed': z.object({
    durationMs: z.number().nonnegative(),
    usage: Usage.optional(),
    /** Present when the run ended by calling client-defined tools. */
    toolCalls: z.array(ToolCall).optional(),
  }),
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
