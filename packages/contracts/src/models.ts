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
  /** Price of input tokens read from the provider's prompt cache, when it differs. */
  cachedInputPerMTok: z.number().nonnegative().optional(),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

/** Cost of a call in USD, rounded to 1e-6. Undefined when pricing is unknown. */
export function estimateCostUsd(
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number } | undefined,
  pricing: ModelPricing | undefined,
): number | undefined {
  if (!usage || !pricing) return undefined;
  // Cached input (a subset of prompt tokens) is billed at the cache-read price when one is known.
  const cached = pricing.cachedInputPerMTok !== undefined ? Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens) : 0;
  const input = (usage.promptTokens - cached) * pricing.inputPerMTok + cached * (pricing.cachedInputPerMTok ?? 0);
  const cost = (input + usage.completionTokens * pricing.outputPerMTok) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export const ModelParameter = z.enum(['temperature', 'maxOutputTokens', 'reasoningBudget', 'tools', 'jsonMode']);
export type ModelParameter = z.infer<typeof ModelParameter>;

/** Provider-dependent fine-tuning availability (PRD §56.31). Never implied when unsupported. */
export const FineTuningStatus = z.enum(['available', 'not_available', 'requires_provider_access', 'coming_soon']);
export type FineTuningStatus = z.infer<typeof FineTuningStatus>;

export const ProviderInfo = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Credentials / endpoint configured. */
  configured: z.boolean(),
  /** Configured and (last health check) reachable. */
  available: z.boolean(),
  /** Circuit breaker state: `open` = skipped after repeated failures, `half_open` = trial request allowed. */
  circuit: z.enum(['closed', 'open', 'half_open']).optional(),
  kind: z.string(),
  /** Endpoint host only — never full URLs with credentials. */
  endpoint: z.string(),
  models: z.number().int(),
  fineTuning: z.object({ status: FineTuningStatus, reason: z.string() }),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

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
  /** Whose key serves this model for the caller: the workspace's own (BYOK) or the platform's. */
  keySource: z.enum(['workspace', 'platform']).optional(),
  /** USD per million tokens, when known. Local models are free. */
  pricing: ModelPricing.optional(),
  /** Request parameters this model honours; unsupported controls must not be offered. */
  supportedParameters: z.array(ModelParameter).optional(),
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
