import { z } from 'zod';

export const RiskLevel = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** JSON Schema is the canonical, interoperable tool contract. */
export type JsonSchema = Record<string, unknown>;

/** Public (serialisable) description of a registered tool. */
export const ToolDescriptor = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  riskLevel: RiskLevel,
  requiresApproval: z.boolean(),
  sideEffects: z.boolean(),
  permissions: z.array(z.string()),
  timeoutMs: z.number().int().positive(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

export const ToolResultStatus = z.enum(['success', 'error', 'timeout', 'denied', 'cancelled']);
export type ToolResultStatus = z.infer<typeof ToolResultStatus>;

export const ToolErrorCode = z.enum([
  'unknown_tool',
  'invalid_arguments',
  'unauthorized',
  'approval_denied',
  'approval_timeout',
  'timeout',
  'execution_failed',
  'cancelled',
  'loop_limit',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export const ToolResult = z.object({
  toolCallId: z.string(),
  name: z.string(),
  status: ToolResultStatus,
  data: z.unknown().optional(),
  error: z
    .object({
      code: ToolErrorCode,
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
  durationMs: z.number().nonnegative(),
  attempts: z.number().int().positive().default(1),
  truncated: z.boolean().default(false),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const ApprovalDecision = z.object({
  toolCallId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
