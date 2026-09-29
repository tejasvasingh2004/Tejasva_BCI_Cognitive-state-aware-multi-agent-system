import { z } from 'zod';

/**
 * OpenAI-compatible Chat Completions request. This is an interoperability boundary only:
 * it is normalised into a NeuroFlow RunRequest and never forwarded to a provider as-is.
 */
const ContentPart = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

export const OpenAIChatMessage = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPart)]).nullable().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function').default('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
});
export type OpenAIChatMessage = z.infer<typeof OpenAIChatMessage>;

export const OpenAIChatCompletionRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(OpenAIChatMessage).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          function: z.object({ name: z.string(), description: z.string().optional() }).passthrough(),
        }),
      )
      .optional(),
    tool_choice: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    user: z.string().optional(),
    /** NeuroFlow extension (ignored by OpenAI clients that do not send it). */
    neuroflow: z
      .object({
        mode: z.enum(['standard', 'cognitive']).optional(),
        agent_strategy: z.string().optional(),
        conversation_id: z.string().uuid().optional(),
      })
      .optional(),
  })
  .passthrough();
export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequest>;

/** Model names that ask NeuroFlow to route automatically instead of pinning a model. */
export const AUTO_MODEL_ALIASES = ['neuroflow', 'neuroflow-auto', 'auto'];
