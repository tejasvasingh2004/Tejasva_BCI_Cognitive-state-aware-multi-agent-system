import { z } from 'zod';

export const ToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Raw JSON string exactly as produced by the model. Never executed without validation. */
  arguments: z.string(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const MessageRole = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRole>;

export const ChatMessage = z.object({
  role: MessageRole,
  content: z.string(),
  name: z.string().optional(),
  toolCalls: z.array(ToolCall).optional(),
  toolCallId: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const Usage = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Estimated USD cost, present only when every contributing model has known pricing. */
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const cost =
    a.costUsd !== undefined && b.costUsd !== undefined ? Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6 : undefined;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}
