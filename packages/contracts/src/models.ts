import { z } from 'zod';

/**
 * A model reference is `<provider>/<model id>`. Only the first `/` separates the provider,
 * so provider-native ids containing `/` or `:` (e.g. `groq/qwen/qwen3-32b`, `qwen/qwen3:8b`) work.
 */
export const ModelRef = z.string().regex(/^[a-z0-9_-]+\/.+$/, 'expected "<provider>/<model>"');
export type ModelRef = z.infer<typeof ModelRef>;

export function parseModelRef(ref: string): { provider: string; model: string } {
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx === ref.length - 1) throw new Error(`Invalid model reference: ${ref}`);
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

export const ModelTier = z.enum(['fast', 'balanced', 'strong']);
export type ModelTier = z.infer<typeof ModelTier>;

export const ModelPricing = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

/** Cost of a call in USD, rounded to 1e-6. Undefined when pricing is unknown. */
export function estimateCostUsd(
  usage: { promptTokens: number; completionTokens: number } | undefined,
  pricing: ModelPricing | undefined,
): number | undefined {
  if (!usage || !pricing) return undefined;
  const cost = (usage.promptTokens * pricing.inputPerMTok + usage.completionTokens * pricing.outputPerMTok) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export const ModelInfo = z.object({
  ref: ModelRef,
  provider: z.string(),
  model: z.string(),
  displayName: z.string(),
  tier: ModelTier,
  contextWindow: z.number().int().positive(),
  capabilities: z.object({
    tools: z.boolean(),
    reasoning: z.boolean(),
    streaming: z.boolean(),
  }),
  available: z.boolean(),
  /** USD per million tokens, when known. Local models are free. */
  pricing: ModelPricing.optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ModelRole = z.enum([
  'primary',
  'agent',
  'research',
  'analysis',
  'synthesis',
  'supervisor',
  'evaluator',
  'refiner',
]);
export type ModelRole = z.infer<typeof ModelRole>;
