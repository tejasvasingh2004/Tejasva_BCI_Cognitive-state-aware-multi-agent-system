import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { ToolCall } from '@neuroflow/contracts';
import { ModelError, httpStatusToError } from '../errors';
import { safeHost } from '../openai-compatible';
import type {
  CatalogEntry,
  CredentialCheck,
  FinishReason,
  ModelMessage,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from '../types';

export type AnthropicAdapterConfig = {
  /** One key, or several comma-separated keys forming a key pool. */
  apiKey?: string;
  baseUrl?: string;
  models: CatalogEntry[];
  fetchImpl?: typeof fetch;
};

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** Output cap when the caller sets none; streaming keeps long outputs within request timeouts. */
const DEFAULT_MAX_TOKENS = 32_000;

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/**
 * Claude through the official Anthropic SDK (Messages API). Differences from the OpenAI wire format
 * are handled here and nowhere else:
 * - system messages go to the top-level `system` prompt; tool results are `tool_result` blocks in a
 *   user turn;
 * - thinking is adaptive with its text omitted (NeuroFlow never shows reasoning); `reasoningBudget`
 *   maps to `output_config.effort`;
 * - an assistant turn's content (including thinking-block signatures) is returned as provider state
 *   and replayed unchanged within the tool loop, which the API requires;
 * - sampling parameters (`temperature`) and forced tool choice are not sent: current Claude models
 *   reject them.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly acceptsCredentials = true;
  private healthy = true;
  private readonly keys: string[];
  private readonly clients = new Map<string, Anthropic>();

  constructor(private readonly config: AnthropicAdapterConfig) {
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
      kind: 'Anthropic API',
      endpoint: safeHost(this.config.baseUrl ?? ANTHROPIC_BASE_URL),
      configured: this.keys.length > 0,
      fineTuning: { status: 'not_available' as const, reason: 'The Anthropic API does not offer self-serve fine-tuning.' },
    };
  }

  async checkHealth(signal?: AbortSignal): Promise<boolean> {
    if (this.keys.length === 0) return (this.healthy = false);
    const check = await this.verifyCredential(this.keys[0]!, signal ?? AbortSignal.timeout(3000));
    this.healthy = check.ok;
    return this.healthy;
  }

  async verifyCredential(apiKey: string, signal?: AbortSignal): Promise<CredentialCheck> {
    try {
      await this.client(apiKey).models.list({ limit: 1 }, { signal: signal ?? AbortSignal.timeout(10_000) });
      return { ok: true };
    } catch (err) {
      if (err instanceof APIError && (err.status === 401 || err.status === 403)) {
        return { ok: false, reason: 'rejected', message: 'The provider rejected this key' };
      }
      if (err instanceof APIError && err.status) {
        return { ok: false, reason: 'unreachable', message: `The provider answered HTTP ${err.status}; try again later` };
      }
      return { ok: false, reason: 'unreachable', message: 'The provider could not be reached; try again later' };
    }
  }

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const apiKey = req.apiKey ?? this.keys[(req.keyIndex ?? 0) % Math.max(1, this.keys.length)];
    if (!apiKey) throw new ModelError('auth', 'No Anthropic API key configured', { retryable: false });
    const client = this.client(apiKey);
    const params = buildParams(req);

    let yielded = false;
    for (let replay = 0; ; replay++) {
      try {
        const stream = client.messages.stream(params, { signal });
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) {
            yielded = true;
            yield { type: 'delta', text: ev.delta.text };
          }
        }
        const message = await stream.finalMessage();
        const calls: ToolCall[] = [];
        for (const block of message.content) {
          if (block.type === 'tool_use') calls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
        }
        const u = message.usage;
        const prompt = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        yield { type: 'usage', usage: { promptTokens: prompt, completionTokens: u.output_tokens, totalTokens: prompt + u.output_tokens } };
        if (calls.length > 0) {
          yield { type: 'state', state: { provider: this.id, model: req.model, content: message.content } };
          for (const call of calls) yield { type: 'tool_call', call };
        }
        yield { type: 'finish', reason: calls.length > 0 ? 'tool_calls' : normalizeStop(message.stop_reason) };
        return;
      } catch (err) {
        // The history no longer matches the conversation a replayed thinking block was produced in
        // (for example a tool result compacted to fit the context budget). The API decides this
        // before any output: drop the thinking blocks and answer without them, once.
        if (replay === 0 && !yielded && isThinkingBindingError(err) && stripThinking(params.messages)) continue;
        throw toModelError(err);
      }
    }
  }

  private client(apiKey: string): Anthropic {
    let c = this.clients.get(apiKey);
    if (!c) {
      c = new Anthropic({
        apiKey,
        baseURL: this.config.baseUrl ?? ANTHROPIC_BASE_URL,
        // The gateway owns retries, timeouts and fallback.
        maxRetries: 0,
        timeout: 10 * 60_000,
        ...(this.config.fetchImpl ? { fetch: this.config.fetchImpl } : {}),
      });
      // Tenant keys come and go; keep the cache bounded.
      if (this.clients.size >= 64) this.clients.delete(this.clients.keys().next().value!);
      this.clients.set(apiKey, c);
    }
    return c;
  }
}

export function buildParams(req: ProviderRequest): CreateParams {
  const { system, messages } = toAnthropicMessages(req.messages, req.model);
  const instructions = [
    ...system,
    ...(req.responseFormat === 'json' ? ['Respond with a single JSON object and nothing else.'] : []),
  ].join('\n\n');
  const params: CreateParams = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(instructions ? { system: instructions } : {}),
  };
  if (req.tools?.length && req.entry.tools) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    // Forced tool use ('required') is rejected by current models; the instructions ask for tools.
    params.tool_choice = req.toolChoice === 'none' ? { type: 'none' } : { type: 'auto' };
  }
  if (req.entry.reasoning !== 'none') {
    const budget = req.reasoningBudget ?? 'off';
    params.thinking = { type: 'adaptive', display: 'omitted' };
    params.output_config = { effort: budget === 'off' ? 'low' : budget };
  }
  return params;
}

/**
 * Converts gateway messages to Messages API turns. System text is returned separately; tool
 * results join the following user turn; consecutive turns of one role are merged. An assistant
 * turn that carries this model's provider state is replayed exactly as the API returned it.
 */
export function toAnthropicMessages(messages: ModelMessage[], model: string): { system: string[]; messages: MessageParam[] } {
  const system: string[] = [];
  const turns: { role: 'user' | 'assistant'; content: ContentBlockParam[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: ContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) system.push(m.content);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content || '(empty)' }]);
    } else if (m.role === 'user') {
      if (m.content) push('user', [{ type: 'text', text: m.content }]);
    } else {
      const state = m.providerState;
      if (state?.provider === 'anthropic' && state.model === model && Array.isArray(state.content)) {
        push('assistant', state.content as ContentBlockParam[]);
        continue;
      }
      const blocks: ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.arguments) });
      push('assistant', blocks);
    }
  }
  return { system, messages: turns };
}

/** Removes thinking blocks from replayed assistant turns; true when any were removed. */
function stripThinking(messages: MessageParam[]): boolean {
  let removed = false;
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (kept.length !== m.content.length) {
      removed = true;
      m.content = kept;
    }
  }
  return removed;
}

function isThinkingBindingError(err: unknown): boolean {
  return err instanceof APIError && err.status === 400 && /signature/i.test(err.message) && /thinking/i.test(err.message);
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeStop(reason: string | null): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function toModelError(err: unknown): unknown {
  if (err instanceof ModelError || err instanceof APIUserAbortError) return err;
  if (err instanceof APIConnectionTimeoutError) return new ModelError('timeout', 'Anthropic request timed out', { cause: err });
  if (err instanceof APIConnectionError) return new ModelError('unavailable', `Provider unreachable: ${err.message}`, { cause: err });
  if (err instanceof APIError && err.status) {
    const body = err.error ? JSON.stringify(err.error) : err.message;
    return httpStatusToError(err.status, body, err.headers?.get('retry-after'));
  }
  return err;
}
