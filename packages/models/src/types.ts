import type { ModelError } from './errors';
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

/** A tenant's own provider key (BYOK). `keyId` is a stable, non-secret id used for budgets and logs. */
export type ProviderCredential = { keyId: string; apiKey: string };

/**
 * Provider-native content of an assistant turn (for example Anthropic thinking blocks with their
 * signatures). It is opaque outside the adapter that produced it, replayed unchanged to the same
 * provider and model within a tool loop, and never shown, logged or persisted.
 */
export type ProviderState = { provider: string; model: string; content: unknown };

/** A chat message as the gateway accepts it: the public contract plus optional provider state. */
export type ModelMessage = ChatMessage & { providerState?: ProviderState };

/**
 * Checked before each model of the fallback chain is tried. Returning an error skips that model
 * (the chain continues with the next one), e.g. when a spending limit is reached.
 */
export type ModelCallGuard = (target: { provider: string; ref: string; keyId?: string }) => Promise<ModelError | undefined>;

export type ModelRequest = {
  /** `<provider>/<model>` reference. */
  model: string;
  /** Tenant keys by provider id; a provider with a credential is called with it, never with a platform key. */
  credentials?: Record<string, ProviderCredential>;
  /** Whether platform (server) keys may serve providers the tenant has no key for. Default true. */
  platformKeys?: boolean;
  guard?: ModelCallGuard;
  /** Tried in order when the primary model fails before producing output. */
  fallbacks?: string[];
  messages: ModelMessage[];
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
  /** The tenant key that served the call (BYOK); absent when a platform key did. */
  keyId?: string;
  /** Attach to the assistant message when continuing a tool loop (see ProviderState). */
  providerState?: ProviderState;
};

/** Normalised events produced by the gateway. Provider reasoning is never surfaced. */
export type ModelEvent =
  | { type: 'attempt'; ref: string; provider: string; model: string; attempt: number }
  | { type: 'retry'; ref: string; attempt: number; reason: string; delayMs: number }
  /** Waiting for provider budget (tokens/requests per minute or a concurrency slot) before sending. */
  | { type: 'throttled'; ref: string; provider: string; waitMs: number; reason: string }
  /** `sameModel`: failover to the same model on another provider (no downgrade). */
  | { type: 'fallback'; from: string; to: string; reason: string; sameModel?: boolean }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; response: ModelResponse };

/** Events emitted by a provider adapter for a single attempt. */
export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'state'; state: ProviderState }
  /** The provider's own rate-limit headers for the key used (remaining budget and reset times). */
  | { type: 'ratelimit'; remainingRequests?: number; remainingTokens?: number; resetRequestsMs?: number; resetTokensMs?: number }
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
  /**
   * Equivalence class: the same model (same weights) served by different providers, e.g.
   * `gpt-oss-120b` on Groq, Together, Fireworks and OpenRouter. Failover tries an equivalent on
   * another provider before falling back to a different model.
   */
  family?: string;
};

export type ProviderRequest = Omit<ModelRequest, 'model' | 'fallbacks' | 'signal' | 'timeoutMs'> & {
  model: string;
  entry: CatalogEntry;
  /** Which API key of the provider's key pool to use (chosen by the gateway's rate limiter). */
  keyIndex?: number;
  /** A tenant's own key; when set it replaces the provider's platform key pool. */
  apiKey?: string;
};

/** Result of checking a key against a provider. Never contains the key. */
export type CredentialCheck = { ok: true } | { ok: false; reason: 'rejected' | 'unreachable'; message: string };

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
  /** Whether tenants can call this provider with their own keys (BYOK). */
  readonly acceptsCredentials?: boolean;
  /** Checks a tenant's key with a cheap authenticated call, before it is stored. */
  verifyCredential?(apiKey: string, signal?: AbortSignal): Promise<CredentialCheck>;
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface ModelGateway {
  listModels(): ModelInfo[];
  defaultModel(): string | undefined;
  /** A view whose calls use a tenant's own provider keys (BYOK); gateways without it ignore tenant keys. */
  scoped?(credentials: Record<string, ProviderCredential>, opts?: { platformKeys?: boolean; guard?: ModelCallGuard }): ModelGateway;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
