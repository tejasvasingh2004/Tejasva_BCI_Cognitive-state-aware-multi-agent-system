import type { z } from 'zod';
import type { RiskLevel, RunEventPayload, RunEventType, ToolResult, WorkspaceContext } from '@neuroflow/contracts';

export type EmitFn = <T extends RunEventType>(type: T, data: RunEventPayload<T>) => void;

/** What a tool implementation may see. Tools never receive raw model output. */
export type ToolContext = {
  runId: string;
  workspaceId: string;
  userId: string;
  scopes: readonly string[];
  signal: AbortSignal;
  emit: EmitFn;
  /** Repository / code workspace the run operates on (Product Phase 2), when any. */
  workspaceContext?: WorkspaceContext;
  /** The model's tool call id (set by the runtime for prepare/execute). */
  toolCallId?: string;
};

/**
 * Result of a tool's optional preparation step, which runs after validation and authorization but
 * before any side effect. It lets approval depend on the actual change (e.g. a computed diff).
 */
export type Prepared<S = unknown> = {
  /** Present when this particular call needs an explicit human decision. */
  approval?: { reason: string; preview?: unknown };
  /** When set, execution is skipped and this is returned as the tool output (e.g. Suggest mode). */
  output?: unknown;
  /** Carried into execute() / onDecision(). */
  state?: S;
};

export type ToolDefinition<I extends z.ZodType = z.ZodType, O = unknown> = {
  name: string;
  description: string;
  /** Zod schema used for validation; its JSON Schema is the interoperable contract. */
  input: I;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  /** Side-effecting tools are never retried automatically and never re-run on recovery. */
  sideEffects: boolean;
  /** Scopes the principal must hold (in addition to `tools:execute`). */
  permissions: string[];
  timeoutMs: number;
  maxRetries?: number;
  /** Upper bound on the serialised result placed into model context. */
  maxResultChars?: number;
  /** Only meaningful inside a code-workspace run (Product Phase 2 repository tools). */
  requiresWorkspace?: boolean;
  /** Optional two-phase tools: compute the proposal (no side effects) and decide on approval. */
  prepare?(args: z.infer<I>, ctx: ToolContext): Promise<Prepared>;
  /** Called after a human decision on a prepared approval (e.g. to record patch status). */
  onDecision?(approved: boolean, prepared: Prepared, ctx: ToolContext): Promise<void> | void;
  execute(args: z.infer<I>, ctx: ToolContext, prepared?: Prepared): Promise<O>;
  /** Short human readable summary for timelines (must not contain secrets). */
  summarize?(output: O): string;
};

export function defineTool<I extends z.ZodType, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return def;
}

/** Thrown by tool implementations to signal a well-understood failure. */
export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export type ApprovalGate = {
  wait(
    runId: string,
    toolCallId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ approved: boolean; reason?: string } | 'timeout'>;
};

/** Persistence hooks for tool calls (implemented with the db package by the worker). */
export type ToolCallRecorder = {
  start(input: {
    runId: string;
    agentExecutionId?: string;
    toolCallId: string;
    name: string;
    arguments: unknown;
    riskLevel?: string;
    approvalStatus: 'not_required' | 'pending';
  }): Promise<void>;
  approval(runId: string, toolCallId: string, status: 'approved' | 'denied' | 'expired'): Promise<void>;
  finish(runId: string, result: ToolResult): Promise<void>;
  findCompleted(runId: string, toolCallId: string): Promise<ToolResult | null>;
};
