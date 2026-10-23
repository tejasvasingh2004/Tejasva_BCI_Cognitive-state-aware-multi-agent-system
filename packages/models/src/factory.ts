import { AnthropicAdapter } from './adapters/anthropic';
import { GroqAdapter } from './adapters/groq';
import { createFireworksAdapter, createGoogleAdapter, createOpenAIAdapter, createOpenRouterAdapter, createTogetherAdapter } from './adapters/hosted';
import { QwenAdapter, type QwenFlavor } from './adapters/qwen';
import { buildCatalog, parsePricing } from './catalog';
import { DefaultModelGateway, type GatewayPolicy, type ProviderLimits } from './gateway';
import type { RateLimiter } from './rate-limit';
import type { ProviderAdapter } from './types';

type Env = Record<string, string | undefined>;

export type GatewayFromEnvOptions = {
  fetchImpl?: typeof fetch;
  /** Shared limiter (e.g. Redis) so provider budgets hold across every worker; in-memory otherwise. */
  limiter?: RateLimiter;
};

/** Builds the gateway from configuration. Enabled models and credentials are env-only. */
export function createGatewayFromEnv(env: Env = process.env, opts: GatewayFromEnvOptions = {}): DefaultModelGateway {
  const adapters: ProviderAdapter[] = [];

  const qwenBaseUrl = env.QWEN_BASE_URL ?? 'http://localhost:11434/v1';
  const qwenFlavor: QwenFlavor =
    env.QWEN_FLAVOR === 'dashscope' || env.QWEN_FLAVOR === 'ollama'
      ? env.QWEN_FLAVOR
      : qwenBaseUrl.includes('dashscope')
        ? 'dashscope'
        : 'ollama';
  adapters.push(
    new QwenAdapter({
      baseUrl: qwenBaseUrl,
      apiKey: env.QWEN_API_KEY || env.DASHSCOPE_API_KEY || undefined,
      flavor: qwenFlavor,
      models: buildCatalog(env.QWEN_MODELS ?? 'qwen3:8b', 'toggle'),
      fetchImpl: opts.fetchImpl,
    }),
  );

  adapters.push(
    new GroqAdapter({
      apiKey: env.GROQ_API_KEY || undefined,
      baseUrl: env.GROQ_BASE_URL || undefined,
      models: buildCatalog(env.GROQ_MODELS ?? 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b'),
      fetchImpl: opts.fetchImpl,
    }),
  );

  // Hosted providers are always registered with a default catalog so workspaces can bring their
  // own keys; without a platform key they serve only workspaces that have one.
  adapters.push(
    new AnthropicAdapter({
      apiKey: env.ANTHROPIC_API_KEY || undefined,
      baseUrl: env.ANTHROPIC_BASE_URL || undefined,
      models: buildCatalog(env.ANTHROPIC_MODELS ?? 'claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5'),
      fetchImpl: opts.fetchImpl,
    }),
    createOpenAIAdapter({
      apiKey: env.OPENAI_API_KEY || undefined,
      baseUrl: env.OPENAI_BASE_URL || undefined,
      models: buildCatalog(env.OPENAI_MODELS ?? 'gpt-6.1-sol,gpt-6-luna,gpt-6-astra'),
      fetchImpl: opts.fetchImpl,
    }),
    createGoogleAdapter({
      apiKey: env.GOOGLE_API_KEY || env.GEMINI_API_KEY || undefined,
      baseUrl: env.GOOGLE_BASE_URL || undefined,
      models: buildCatalog(env.GOOGLE_MODELS ?? 'gemini-3.8-flash'),
      fetchImpl: opts.fetchImpl,
    }),
    // Hosted open-weight models.
    createTogetherAdapter({
      apiKey: env.TOGETHER_API_KEY || undefined,
      baseUrl: env.TOGETHER_BASE_URL || undefined,
      models: buildCatalog(env.TOGETHER_MODELS ?? 'openai/gpt-oss-120b,Qwen/Qwen3.8-Flash,deepseek-ai/DeepSeek-V4.1-Flash'),
      fetchImpl: opts.fetchImpl,
    }),
    createFireworksAdapter({
      apiKey: env.FIREWORKS_API_KEY || undefined,
      baseUrl: env.FIREWORKS_BASE_URL || undefined,
      models: buildCatalog(env.FIREWORKS_MODELS ?? 'accounts/fireworks/models/gpt-oss-120b'),
      fetchImpl: opts.fetchImpl,
    }),
    createOpenRouterAdapter({
      apiKey: env.OPENROUTER_API_KEY || undefined,
      baseUrl: env.OPENROUTER_BASE_URL || undefined,
      models: buildCatalog(env.OPENROUTER_MODELS ?? 'openai/gpt-oss-120b'),
      fetchImpl: opts.fetchImpl,
    }),
  );

  const policy: Partial<GatewayPolicy> = {
    defaultModel: env.MODEL_DEFAULT || undefined,
    defaultFallbacks: (env.MODEL_FALLBACKS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...num(env.MODEL_MAX_RETRIES, (v) => ({ maxRetries: v })),
    ...num(env.MODEL_TIMEOUT_MS, (v) => ({ attemptTimeoutMs: v })),
    ...num(env.MODEL_FIRST_TOKEN_TIMEOUT_MS, (v) => ({ firstTokenTimeoutMs: v })),
    ...num(env.MODEL_IDLE_TIMEOUT_MS, (v) => ({ idleTimeoutMs: v })),
    pricing: parsePricing(env.MODEL_PRICING),
    providerConcurrency: parseConcurrency(env.MODEL_PROVIDER_CONCURRENCY),
    providerLimits: parseProviderLimits(env.MODEL_PROVIDER_LIMITS),
    ...num(env.MODEL_MAX_RATE_LIMIT_WAIT_MS, (v) => ({ maxRateLimitWaitMs: v })),
    circuitBreaker: {
      failureThreshold: positive(env.MODEL_CIRCUIT_FAILURES) ?? 5,
      openMs: positive(env.MODEL_CIRCUIT_OPEN_MS) ?? 30_000,
      maxOpenMs: positive(env.MODEL_CIRCUIT_MAX_OPEN_MS) ?? 5 * 60_000,
    },
  };
  return new DefaultModelGateway(adapters, policy, opts.limiter ? { limiter: opts.limiter } : {});
}

/**
 * `MODEL_PROVIDER_LIMITS=groq:tpm=8000,rpm=30,concurrency=8;qwen:concurrency=2`
 * tpm/rpm apply per API key (a key pool multiplies them); concurrency applies per provider.
 */
export function parseProviderLimits(spec: string | undefined): Record<string, ProviderLimits> {
  const out: Record<string, ProviderLimits> = {};
  for (const item of (spec ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const colon = item.indexOf(':');
    if (colon <= 0) continue;
    const provider = item.slice(0, colon).trim();
    const limits: ProviderLimits = {};
    for (const pair of item.slice(colon + 1).split(',')) {
      const [k, v] = pair.split('=').map((s) => s.trim());
      const n = Number(v);
      if (!(n > 0)) continue;
      if (k === 'tpm') limits.tokensPerMinute = Math.floor(n);
      else if (k === 'rpm') limits.requestsPerMinute = Math.floor(n);
      else if (k === 'concurrency') limits.concurrency = Math.floor(n);
    }
    if (Object.keys(limits).length) out[provider] = limits;
  }
  return out;
}

function positive(raw: string | undefined): number | undefined {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** `MODEL_PROVIDER_CONCURRENCY=qwen=2,groq=16` */
function parseConcurrency(spec: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [provider, n] = item.split('=');
    if (provider && Number(n) > 0) out[provider.trim()] = Math.floor(Number(n));
  }
  return out;
}

function num<T>(raw: string | undefined, f: (v: number) => T): T | object {
  const v = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? f(v) : {};
}
