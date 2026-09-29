import type { z } from 'zod';
import type { RiskLevel, RunEventPayload, RunEventType, ToolResult } from '@neuroflow/contracts';

export type EmitFn = <T extends RunEventType>(type: T, data: RunEventPayload<T>) => void;

/** What a tool implementation may see. Tools never receive raw model output. */
export type ToolContext = {
  runId: string;
  workspaceId: string;
  userId: string;
  scopes: readonly string[];
  signal: AbortSignal;
  emit: EmitFn;
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
  execute(args: z.infer<I>, ctx: ToolContext): Promise<O>;
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
