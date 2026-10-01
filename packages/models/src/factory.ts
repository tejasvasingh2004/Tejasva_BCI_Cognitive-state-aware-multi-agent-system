import { GroqAdapter } from './adapters/groq';
import { QwenAdapter, type QwenFlavor } from './adapters/qwen';
import { buildCatalog, parsePricing } from './catalog';
import { DefaultModelGateway, type GatewayPolicy } from './gateway';
import type { ProviderAdapter } from './types';

type Env = Record<string, string | undefined>;

export type GatewayFromEnvOptions = { fetchImpl?: typeof fetch };

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
      models: buildCatalog(env.GROQ_MODELS ?? 'llama-3.3-70b-versatile,llama-3.1-8b-instant,qwen/qwen3-32b'),
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
  };
  return new DefaultModelGateway(adapters, policy);
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
