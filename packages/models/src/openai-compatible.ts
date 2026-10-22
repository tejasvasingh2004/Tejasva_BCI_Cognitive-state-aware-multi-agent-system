import type { ChatMessage, ToolCall } from '@neuroflow/contracts';
import { ModelError, httpStatusToError, isAbortError } from './errors';
import { readSseData } from './sse';
import { ThinkFilter } from './think-filter';
import type { FinishReason, ProviderEvent, ProviderRequest, CredentialCheck } from './types';

/**
 * Shared transport for providers that speak the OpenAI Chat Completions wire protocol
 * (Ollama, DashScope compatible-mode, Groq, vLLM…). Provider-specific request options are
 * supplied by the adapter via `extraBody`; nothing outside `packages/models` sees this format.
 */
export type OpenAICompatibleOptions = {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
};

type WireToolCallDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type WireChunk = {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: WireToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: { message?: string };
};

export function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) };
  });
}

export async function* streamOpenAICompatible(
  opts: OpenAICompatibleOptions,
  req: ProviderRequest,
  signal: AbortSignal,
  extraBody: Record<string, unknown> = {},
): AsyncGenerator<ProviderEvent> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toWireMessages(req.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
    ...(req.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    ...extraBody,
  };
  if (req.tools?.length && req.entry.tools) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    body.tool_choice = req.toolChoice ?? 'auto';
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        ...opts.headers,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ModelError('unavailable', `Provider unreachable: ${(err as Error).message}`, { cause: err });
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw httpStatusToError(res.status, text, res.headers.get('retry-after'));
  }

  const think = new ThinkFilter();
  const toolParts = new Map<number, { id: string; name: string; args: string }>();
  let finish: FinishReason | undefined;
  let leading = true;

  const emitText = (raw: string): ProviderEvent | undefined => {
    let text = think.push(raw);
    if (leading) {
      text = text.replace(/^\s+/, '');
      if (text.length === 0) return undefined;
      leading = false;
    }
    return text.length > 0 ? { type: 'delta', text } : undefined;
  };

  for await (const data of readSseData(res.body)) {
    if (data === '[DONE]') break;
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(data) as WireChunk;
    } catch {
      continue;
    }
    if (chunk.error) throw new ModelError('provider_error', chunk.error.message ?? 'Provider stream error');

    for (const choice of chunk.choices ?? []) {
      // Only `content` is user-visible. Provider reasoning fields (`reasoning`,
      // `reasoning_content`) are intentionally ignored so private reasoning never leaves here.
      const content = choice.delta?.content;
      if (content) {
        const ev = emitText(content);
        if (ev) yield ev;
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const part = toolParts.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) part.id = tc.id;
        if (tc.function?.name) part.name += tc.function.name;
        if (tc.function?.arguments) part.args += tc.function.arguments;
        toolParts.set(idx, part);
      }
      if (choice.finish_reason) finish = normalizeFinish(choice.finish_reason);
    }
    if (chunk.usage && chunk.usage.total_tokens !== undefined) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        },
      };
    }
  }

  const tail = think.flush();
  if (tail) {
    const ev = emitText(tail);
    if (ev) yield ev;
  }

  const calls: ToolCall[] = [...toolParts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, p]) => ({ id: p.id || `call_${idx}`, name: p.name, arguments: p.args || '{}' }));
  for (const call of calls) yield { type: 'tool_call', call };

  yield { type: 'finish', reason: calls.length > 0 ? 'tool_calls' : (finish ?? 'unknown') };
}

function normalizeFinish(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return reason;
    case 'function_call':
      return 'tool_calls';
    default:
      return 'unknown';
  }
}

/** Lightweight reachability probe against `GET {baseUrl}/models`. */
export async function probeOpenAICompatible(
  opts: OpenAICompatibleOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl.replace(/\/$/, '')}/models`, {
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      signal: signal ?? AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Checks an API key with `GET {baseUrl}/models`: accepted, rejected by the provider (401/403), or
 * not checkable right now. The key is never echoed in the result.
 */
export async function verifyOpenAICompatibleKey(
  opts: OpenAICompatibleOptions,
  signal?: AbortSignal,
): Promise<CredentialCheck> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${opts.apiKey ?? ''}` },
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected', message: 'The provider rejected this key' };
    return { ok: false, reason: 'unreachable', message: `The provider answered HTTP ${res.status}; try again later` };
  } catch {
    return { ok: false, reason: 'unreachable', message: 'The provider could not be reached; try again later' };
  }
}

/** Host (and port) of an endpoint, for display — never credentials, paths or query strings. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
