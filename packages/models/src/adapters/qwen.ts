import type { ReasoningBudget } from '@neuroflow/contracts';
import { probeOpenAICompatible, safeHost, streamOpenAICompatible, verifyOpenAICompatibleKey } from '../openai-compatible';
import type { CatalogEntry, CredentialCheck, ProviderAdapter, ProviderEvent, ProviderRequest } from '../types';

/**
 * Qwen served either by Ollama (local, default) or DashScope compatible-mode (hosted).
 * Both speak the OpenAI wire protocol but differ in how reasoning is controlled.
 */
export type QwenFlavor = 'ollama' | 'dashscope';

export type QwenAdapterConfig = {
  baseUrl: string;
  apiKey?: string;
  flavor: QwenFlavor;
  models: CatalogEntry[];
  fetchImpl?: typeof fetch;
};

const DASHSCOPE_THINKING_BUDGET: Record<Exclude<ReasoningBudget, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 16_384,
};

export class QwenAdapter implements ProviderAdapter {
  readonly id = 'qwen';
  readonly displayName = 'Qwen';
  private healthy: boolean;

  constructor(private readonly config: QwenAdapterConfig) {
    // Hosted endpoints need a key; a local Ollama endpoint is assumed reachable until probed.
    this.healthy = config.flavor === 'dashscope' ? Boolean(config.apiKey) : true;
  }

  catalog(): CatalogEntry[] {
    // Local Ollama inference has no per-token cost (unless pricing is configured explicitly).
    if (this.config.flavor !== 'ollama') return this.config.models;
    return this.config.models.map((m) => (m.pricing ? m : { ...m, pricing: { inputPerMTok: 0, outputPerMTok: 0 } }));
  }

  isAvailable(): boolean {
    return this.config.models.length > 0 && this.healthy;
  }

  describe() {
    const local = this.config.flavor === 'ollama';
    return {
      kind: local ? 'Ollama (local)' : 'DashScope (Alibaba Cloud Model Studio)',
      endpoint: safeHost(this.config.baseUrl),
      configured: local ? true : Boolean(this.config.apiKey),
      fineTuning: local
        ? { status: 'not_available' as const, reason: 'Local Ollama models cannot be fine-tuned through an API. Train elsewhere and import the result into Ollama.' }
        : {
            status: 'coming_soon' as const,
            reason: 'DashScope offers fine-tuning for some Qwen models; the NeuroFlow integration is not implemented yet (adapter boundary: FineTuningAdapter).',
          },
    };
  }

  async checkHealth(signal?: AbortSignal): Promise<boolean> {
    if (this.config.flavor === 'dashscope' && !this.config.apiKey) return (this.healthy = false);
    this.healthy = await probeOpenAICompatible(this.opts(), signal);
    return this.healthy;
  }

  get acceptsCredentials(): boolean {
    return this.config.flavor === 'dashscope';
  }

  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const opts = req.apiKey ? { ...this.opts(), apiKey: req.apiKey } : this.opts();
    return streamOpenAICompatible(opts, req, signal, this.reasoningOptions(req));
  }

  verifyCredential(apiKey: string, signal?: AbortSignal): Promise<CredentialCheck> {
    return verifyOpenAICompatibleKey({ ...this.opts(), apiKey }, signal);
  }

  /** Translates the provider-independent reasoning budget into Qwen controls. */
  reasoningOptions(req: ProviderRequest): Record<string, unknown> {
    if (req.entry.reasoning === 'none') return {};
    const budget = req.reasoningBudget ?? 'off';
    if (this.config.flavor === 'dashscope') {
      return budget === 'off'
        ? { enable_thinking: false }
        : { enable_thinking: true, thinking_budget: DASHSCOPE_THINKING_BUDGET[budget] };
    }
    // Ollama maps reasoning_effort onto its `think` option; reasoning is returned in a separate
    // field which the transport discards.
    return { reasoning_effort: budget === 'off' ? 'none' : budget };
  }

  private opts() {
    return { baseUrl: this.config.baseUrl, apiKey: this.config.apiKey, fetchImpl: this.config.fetchImpl };
  }
}
