import type { CatalogEntry, ReasoningStyle } from './types';
import type { ModelPricing, ModelTier } from '@neuroflow/contracts';

type KnownModel = Omit<CatalogEntry, 'model'>;

/**
 * Metadata for well-known models. Unknown models are still usable; they get conservative
 * defaults. Which models are enabled is purely configuration (env), never code.
 */
const KNOWN: Record<string, KnownModel> = {
  // Qwen via Ollama tags
  'qwen3:0.6b': km('Qwen3 0.6B', 'fast', 32_768, true, 'toggle'),
  'qwen3:1.7b': km('Qwen3 1.7B', 'fast', 32_768, true, 'toggle'),
  'qwen3:4b': km('Qwen3 4B', 'fast', 32_768, true, 'toggle'),
  'qwen3:8b': km('Qwen3 8B', 'balanced', 32_768, true, 'toggle'),
  'qwen3:14b': km('Qwen3 14B', 'balanced', 32_768, true, 'toggle'),
  'qwen3:32b': km('Qwen3 32B', 'strong', 32_768, true, 'toggle'),
  'qwen2.5:7b': km('Qwen2.5 7B', 'balanced', 32_768, true, 'none'),
  // Qwen via DashScope (Alibaba Cloud Model Studio)
  'qwen-flash': km('Qwen Flash', 'fast', 131_072, true, 'toggle'),
  'qwen-turbo': km('Qwen Turbo', 'fast', 131_072, true, 'toggle'),
  'qwen-plus': km('Qwen Plus', 'balanced', 131_072, true, 'toggle'),
  'qwen-max': km('Qwen Max', 'strong', 32_768, true, 'none'),
  // Groq (list prices, USD per 1M input/output tokens; override with MODEL_PRICING)
  'llama-3.1-8b-instant': km('Llama 3.1 8B Instant', 'fast', 131_072, true, 'none', [0.05, 0.08]),
  'llama-3.3-70b-versatile': km('Llama 3.3 70B', 'strong', 131_072, true, 'none', [0.59, 0.79]),
  // No longer on Groq's model list (October 2026); kept so existing configurations still resolve.
  'qwen/qwen3-32b': km('Qwen3 32B (Groq)', 'strong', 131_072, true, 'toggle', [0.29, 0.59]),
  // Preview on Groq (may be withdrawn at short notice); no published list price yet — set MODEL_PRICING.
  'qwen/qwen3.8-27b': km('Qwen3.8 27B (Groq, preview)', 'balanced', 131_072, true, 'toggle'),
  'openai/gpt-oss-20b': km('GPT-OSS 20B', 'balanced', 131_072, true, 'effort', [0.075, 0.3]),
  'openai/gpt-oss-120b': km('GPT-OSS 120B', 'strong', 131_072, true, 'effort', [0.15, 0.6]),
};

function km(
  displayName: string,
  tier: ModelTier,
  contextWindow: number,
  tools: boolean,
  reasoning: ReasoningStyle,
  price?: [number, number],
): KnownModel {
  return {
    displayName,
    tier,
    contextWindow,
    tools,
    reasoning,
    ...(price ? { pricing: { inputPerMTok: price[0], outputPerMTok: price[1] } } : {}),
  };
}

/**
 * Parses `MODEL_PRICING`: comma separated `<provider>/<model>=<input>:<output>` (USD per 1M tokens),
 * e.g. `groq/llama-3.3-70b-versatile=0.59:0.79,qwen/qwen-plus=0.4:1.2`.
 */
export function parsePricing(spec: string | undefined): Map<string, ModelPricing> {
  const out = new Map<string, ModelPricing>();
  for (const item of (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = item.lastIndexOf('=');
    const [inp, outp] = item.slice(eq + 1).split(':').map(Number);
    if (eq > 0 && Number.isFinite(inp) && Number.isFinite(outp) && inp! >= 0 && outp! >= 0) {
      out.set(item.slice(0, eq), { inputPerMTok: inp!, outputPerMTok: outp! });
    }
  }
  return out;
}

/**
 * Builds catalog entries from a comma separated list. Each item may override metadata:
 * `model[|tier][|contextWindow]`, e.g. `qwen3:8b,my-finetune|strong|65536`.
 */
export function buildCatalog(spec: string | undefined, fallbackReasoning: ReasoningStyle = 'none'): CatalogEntry[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const [model = '', tier, ctx] = item.split('|').map((p) => p.trim());
      const known = KNOWN[model];
      const base: KnownModel = known ?? km(model, 'balanced', 32_768, true, fallbackReasoning);
      return {
        model,
        ...base,
        tier: isTier(tier) ? tier : base.tier,
        contextWindow: ctx && Number(ctx) > 0 ? Number(ctx) : base.contextWindow,
      };
    });
}

function isTier(v: string | undefined): v is ModelTier {
  return v === 'fast' || v === 'balanced' || v === 'strong';
}
