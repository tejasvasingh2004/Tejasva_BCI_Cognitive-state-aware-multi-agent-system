import { probeOpenAICompatible, safeHost, streamOpenAICompatible, verifyOpenAICompatibleKey } from '../openai-compatible';
import type { CatalogEntry, CredentialCheck, ProviderAdapter, ProviderEvent, ProviderRequest } from '../types';

export type GroqAdapterConfig = {
  /** One key, or several comma-separated keys forming a key pool. */
  apiKey?: string;
  baseUrl?: string;
  models: CatalogEntry[];
  fetchImpl?: typeof fetch;
};

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export class GroqAdapter implements ProviderAdapter {
  readonly id = 'groq';
  readonly displayName = 'Groq';
  readonly acceptsCredentials = true;
  private healthy = true;

  private readonly keys: string[];

  constructor(private readonly config: GroqAdapterConfig) {
    this.keys = (config.apiKey ?? '').split(',').map((k) => k.trim()).filter(Boolean);
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

  describe() {
    return {
      kind: 'Groq Cloud',
      endpoint: safeHost(this.config.baseUrl ?? GROQ_BASE_URL),
      configured: this.keys.length > 0,
      fineTuning: { status: 'not_available' as const, reason: 'Groq does not offer a public fine-tuning API.' },
    };
  }

  async checkHealth(signal?: AbortSignal): Promise<boolean> {
    if (this.keys.length === 0) return (this.healthy = false);
    this.healthy = await probeOpenAICompatible(this.opts(), signal);
    return this.healthy;
  }

  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const opts = req.apiKey ? { ...this.opts(), apiKey: req.apiKey } : this.opts(req.keyIndex);
    return streamOpenAICompatible(opts, req, signal, this.reasoningOptions(req));
  }

  verifyCredential(apiKey: string, signal?: AbortSignal): Promise<CredentialCheck> {
    return verifyOpenAICompatibleKey({ ...this.opts(), apiKey }, signal);
  }

  /**
   * Groq reasoning controls differ per model family. Reasoning output is always hidden:
   * NeuroFlow never exposes private chain-of-thought.
   */
  reasoningOptions(req: ProviderRequest): Record<string, unknown> {
    const budget = req.reasoningBudget ?? 'off';
    if (req.entry.reasoning === 'toggle') {
      return { reasoning_effort: budget === 'off' ? 'none' : 'default', reasoning_format: 'hidden' };
    }
    if (req.entry.reasoning === 'effort') {
      return { reasoning_effort: budget === 'off' ? 'low' : budget, include_reasoning: false };
    }
    return {};
  }

  private opts(keyIndex = 0) {
    return {
      baseUrl: this.config.baseUrl ?? GROQ_BASE_URL,
      apiKey: this.keys.length ? this.keys[keyIndex % this.keys.length] : undefined,
      fetchImpl: this.config.fetchImpl,
    };
  }
}
