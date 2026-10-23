import { probeOpenAICompatible, safeHost, streamOpenAICompatible, verifyOpenAICompatibleKey } from '../openai-compatible';
import type { CatalogEntry, CredentialCheck, ProviderAdapter, ProviderDescription, ProviderEvent, ProviderRequest } from '../types';

export type HostedAdapterConfig = {
  /** One key, or several comma-separated keys forming a key pool. */
  apiKey?: string;
  baseUrl?: string;
  models: CatalogEntry[];
  fetchImpl?: typeof fetch;
};

type HostedProfile = {
  id: string;
  displayName: string;
  baseUrl: string;
  kind: string;
  fineTuning: ProviderDescription['fineTuning'];
  /** Provider-specific request fields for one call (reasoning, token limits, sampling). */
  options(req: ProviderRequest): Record<string, unknown>;
  /** Authenticated endpoint used to check a key (default `/models`). */
  verifyPath?: string;
  /** Extra request headers (e.g. attribution). Never credentials. */
  headers?: Record<string, string>;
};

/**
 * A hosted provider reached through its OpenAI-compatible Chat Completions endpoint, with a key
 * pool and bring-your-own-key support. Provider differences live in the profile.
 */
export class HostedOpenAICompatibleAdapter implements ProviderAdapter {
  readonly acceptsCredentials = true;
  private healthy = true;
  private readonly keys: string[];

  constructor(
    private readonly profile: HostedProfile,
    private readonly config: HostedAdapterConfig,
  ) {
    this.keys = (config.apiKey ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  }

  get id(): string {
    return this.profile.id;
  }

  get displayName(): string {
    return this.profile.displayName;
  }

  keyCount(): number {
    return Math.max(1, this.keys.length);
  }

  catalog(): CatalogEntry[] {
    return this.config.models;
  }

  isAvailable(): boolean {
    return this.keys.length > 0 && this.config.models.length > 0 && this.healthy;
  }

  describe(): ProviderDescription {
    return {
      kind: this.profile.kind,
      endpoint: safeHost(this.baseUrl()),
      configured: this.keys.length > 0,
      fineTuning: this.profile.fineTuning,
    };
  }

  async checkHealth(signal?: AbortSignal): Promise<boolean> {
    if (this.keys.length === 0) return (this.healthy = false);
    this.healthy = await probeOpenAICompatible(this.opts(), signal);
    return this.healthy;
  }

  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const opts = req.apiKey ? { ...this.opts(), apiKey: req.apiKey } : this.opts(req.keyIndex);
    return streamOpenAICompatible(opts, req, signal, this.profile.options(req));
  }

  verifyCredential(apiKey: string, signal?: AbortSignal): Promise<CredentialCheck> {
    return verifyOpenAICompatibleKey({ ...this.opts(), apiKey }, signal, this.profile.verifyPath);
  }

  private baseUrl(): string {
    return this.config.baseUrl ?? this.profile.baseUrl;
  }

  private opts(keyIndex = 0) {
    return {
      baseUrl: this.baseUrl(),
      apiKey: this.keys.length ? this.keys[keyIndex % this.keys.length] : undefined,
      fetchImpl: this.config.fetchImpl,
      ...(this.profile.headers ? { headers: this.profile.headers } : {}),
    };
  }
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * OpenAI. Current models are reasoning models: output is capped with `max_completion_tokens`
 * (`max_tokens` is the legacy field) and sampling parameters are not sent.
 */
export function createOpenAIAdapter(config: HostedAdapterConfig): HostedOpenAICompatibleAdapter {
  return new HostedOpenAICompatibleAdapter(
    {
      id: 'openai',
      displayName: 'OpenAI',
      baseUrl: OPENAI_BASE_URL,
      kind: 'OpenAI API',
      fineTuning: {
        status: 'requires_provider_access',
        reason: 'OpenAI offers fine-tuning for some models in its own dashboard; NeuroFlow does not start jobs or send repository data for training.',
      },
      options(req) {
        const budget = req.reasoningBudget ?? 'off';
        return {
          max_tokens: undefined,
          ...(req.maxOutputTokens !== undefined ? { max_completion_tokens: req.maxOutputTokens } : {}),
          ...(req.entry.reasoning !== 'none' ? { temperature: undefined, reasoning_effort: budget === 'off' ? 'low' : budget } : {}),
        };
      },
    },
    config,
  );
}

/**
 * Google Gemini through its OpenAI compatibility endpoint. Gemini 3 models always think;
 * `reasoning_effort` sets how much (`minimal` is the lowest).
 */
export function createGoogleAdapter(config: HostedAdapterConfig): HostedOpenAICompatibleAdapter {
  return new HostedOpenAICompatibleAdapter(
    {
      id: 'google',
      displayName: 'Google Gemini',
      baseUrl: GOOGLE_BASE_URL,
      kind: 'Gemini API (OpenAI compatible)',
      fineTuning: { status: 'not_available', reason: 'Fine-tuning is not available through the Gemini API endpoint NeuroFlow uses; no training jobs are started.' },
      options(req) {
        if (req.entry.reasoning === 'none') return {};
        const budget = req.reasoningBudget ?? 'off';
        return { reasoning_effort: budget === 'off' ? 'minimal' : budget };
      },
    },
    config,
  );
}

export const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Open-weight models with effort-based reasoning (GPT-OSS) take `reasoning_effort`; others get nothing. */
const openModelOptions = (req: ProviderRequest): Record<string, unknown> =>
  req.entry.reasoning === 'effort' ? { reasoning_effort: (req.reasoningBudget ?? 'off') === 'off' ? 'low' : req.reasoningBudget } : {};

const NO_TUNING = (host: string): ProviderDescription['fineTuning'] => ({
  status: 'requires_provider_access',
  reason: `${host} offers fine-tuning in its own console; NeuroFlow does not start jobs or send repository data for training.`,
});

/** Together AI: hosted open-weight models (Llama, Qwen, DeepSeek, GPT-OSS, Kimi). */
export function createTogetherAdapter(config: HostedAdapterConfig): HostedOpenAICompatibleAdapter {
  return new HostedOpenAICompatibleAdapter(
    { id: 'together', displayName: 'Together AI', baseUrl: TOGETHER_BASE_URL, kind: 'Together AI (OpenAI compatible)', fineTuning: NO_TUNING('Together AI'), options: openModelOptions },
    config,
  );
}

/** Fireworks AI: hosted open-weight models; model ids look like `accounts/fireworks/models/<name>`. */
export function createFireworksAdapter(config: HostedAdapterConfig): HostedOpenAICompatibleAdapter {
  return new HostedOpenAICompatibleAdapter(
    { id: 'fireworks', displayName: 'Fireworks AI', baseUrl: FIREWORKS_BASE_URL, kind: 'Fireworks AI (OpenAI compatible)', fineTuning: NO_TUNING('Fireworks AI'), options: openModelOptions },
    config,
  );
}

/**
 * OpenRouter: one key for many providers' models (`<provider>/<model>` ids). Its model list is
 * public, so keys are checked with `GET /key`. Reasoning uses OpenRouter's unified `reasoning`
 * field, with the reasoning text excluded from the response.
 */
export function createOpenRouterAdapter(config: HostedAdapterConfig): HostedOpenAICompatibleAdapter {
  return new HostedOpenAICompatibleAdapter(
    {
      id: 'openrouter',
      displayName: 'OpenRouter',
      baseUrl: OPENROUTER_BASE_URL,
      kind: 'OpenRouter (OpenAI compatible)',
      fineTuning: { status: 'not_available', reason: 'OpenRouter routes to other providers and does not offer fine-tuning.' },
      verifyPath: '/key',
      headers: { 'X-OpenRouter-Title': 'NeuroFlow' },
      options(req) {
        if (req.entry.reasoning === 'none') return {};
        const budget = req.reasoningBudget ?? 'off';
        return { reasoning: { effort: budget === 'off' ? 'low' : budget, exclude: true } };
      },
    },
    config,
  );
}
