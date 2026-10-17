import type {
  ChatMessage,
  JsonSchema,
  ModelInfo,
  ModelPricing,
  ModelTier,
  ReasoningBudget,
  ToolCall,
  Usage,
} from '@neuroflow/contracts';

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ToolChoice = 'auto' | 'none' | 'required';

export type ModelRequest = {
  /** `<provider>/<model>` reference. */
  model: string;
  /** Tried in order when the primary model fails before producing output. */
  fallbacks?: string[];
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningBudget?: ReasoningBudget;
  /** Ask the provider for a JSON object response where supported. */
  responseFormat?: 'text' | 'json';
  signal?: AbortSignal;
  /** Overrides the gateway's per-attempt timeout. */
  timeoutMs?: number;
};

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown';

export type ModelResponse = {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: Usage;
  provider: string;
  model: string;
  ref: string;
  latencyMs: number;
  firstTokenMs?: number;
  attempts: number;
  /** Set when the response came from a fallback model. */
  fallbackFrom?: string;
};

/** Normalised events produced by the gateway. Provider reasoning is never surfaced. */
export type ModelEvent =
  | { type: 'attempt'; ref: string; provider: string; model: string; attempt: number }
  | { type: 'retry'; ref: string; attempt: number; reason: string; delayMs: number }
  /** Waiting for provider budget (tokens/requests per minute or a concurrency slot) before sending. */
  | { type: 'throttled'; ref: string; provider: string; waitMs: number; reason: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; response: ModelResponse };

/** Events emitted by a provider adapter for a single attempt. */
export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason };

export type ReasoningStyle =
  /** Model has no controllable reasoning. */
  | 'none'
  /** Qwen3-style hybrid thinking that can be toggled on/off. */
  | 'toggle'
  /** Effort-based reasoning (low/medium/high). */
  | 'effort';

export type CatalogEntry = {
  model: string;
  displayName: string;
  tier: ModelTier;
  contextWindow: number;
  tools: boolean;
  reasoning: ReasoningStyle;
  /** USD per million tokens; undefined when unknown. */
  pricing?: ModelPricing;
};

export type ProviderRequest = Omit<ModelRequest, 'model' | 'fallbacks' | 'signal' | 'timeoutMs'> & {
  model: string;
  entry: CatalogEntry;
  /** Which API key of the provider's key pool to use (chosen by the gateway's rate limiter). */
  keyIndex?: number;
};

export type ProviderDescription = {
  kind: string;
  endpoint: string;
  configured: boolean;
  fineTuning: { status: 'available' | 'not_available' | 'requires_provider_access' | 'coming_soon'; reason: string };
};

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Static facts for Model Lab (endpoint host, configuration, fine-tuning capability). */
  describe?(): ProviderDescription;
  catalog(): CatalogEntry[];
  /** Whether the provider is configured and (as far as we know) reachable. */
  isAvailable(): boolean;
  /** Refresh reachability; adapters without a health probe may no-op. */
  checkHealth?(signal?: AbortSignal): Promise<boolean>;
  /** Number of API keys in the provider's key pool (each key has its own provider quota). */
  keyCount?(): number;
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface ModelGateway {
  listModels(): ModelInfo[];
  defaultModel(): string | undefined;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
