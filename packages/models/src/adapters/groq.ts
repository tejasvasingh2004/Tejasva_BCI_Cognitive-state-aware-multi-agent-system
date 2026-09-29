import { probeOpenAICompatible, streamOpenAICompatible } from '../openai-compatible';
import type { CatalogEntry, ProviderAdapter, ProviderEvent, ProviderRequest } from '../types';

export type GroqAdapterConfig = {
  apiKey?: string;
  baseUrl?: string;
  models: CatalogEntry[];
  fetchImpl?: typeof fetch;
};

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export class GroqAdapter implements ProviderAdapter {
  readonly id = 'groq';
  readonly displayName = 'Groq';
  private healthy = true;

  constructor(private readonly config: GroqAdapterConfig) {}

  catalog(): CatalogEntry[] {
    return this.config.models;
  }

  isAvailable(): boolean {
    return Boolean(this.config.apiKey) && this.config.models.length > 0 && this.healthy;
  }

  async checkHealth(signal?: AbortSignal): Promise<boolean> {
    if (!this.config.apiKey) return (this.healthy = false);
    this.healthy = await probeOpenAICompatible(this.opts(), signal);
    return this.healthy;
  }

  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    return streamOpenAICompatible(this.opts(), req, signal, this.reasoningOptions(req));
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

  private opts() {
    return {
      baseUrl: this.config.baseUrl ?? GROQ_BASE_URL,
      apiKey: this.config.apiKey,
      fetchImpl: this.config.fetchImpl,
    };
  }
}
