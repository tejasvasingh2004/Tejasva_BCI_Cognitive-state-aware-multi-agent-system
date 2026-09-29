import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Test double for an OpenAI-compatible provider (used by unit, integration and E2E tests only).
 * It is a real HTTP server so the full transport path — fetch, SSE parsing, tool-call assembly,
 * timeouts and aborts — is exercised exactly as in production.
 */
export type MockChunk = { content?: string; reasoning?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> };

export type MockReply =
  | { kind: 'stream'; chunks: MockChunk[]; chunkDelayMs?: number; finishReason?: string; usage?: boolean; hangAfter?: number }
  | { kind: 'error'; status: number; message?: string; retryAfter?: string }
  | { kind: 'hang' };

export type MockRequestBody = {
  model: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
  [k: string]: unknown;
};

export type MockScript = (body: MockRequestBody, callIndex: number) => MockReply;

export type MockOpenAIServer = {
  url: string;
  requests: MockRequestBody[];
  setScript(script: MockScript): void;
  close(): Promise<void>;
};

export async function startMockOpenAIServer(script: MockScript = defaultScript, port = 0): Promise<MockOpenAIServer> {
  let current = script;
  const requests: MockRequestBody[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const raw = await readBody(req);
    const body = JSON.parse(raw) as MockRequestBody;
    requests.push(body);
    const reply = current(body, requests.length - 1);

    if (reply.kind === 'error') {
      res.writeHead(reply.status, {
        'content-type': 'application/json',
        ...(reply.retryAfter ? { 'retry-after': reply.retryAfter } : {}),
      });
      res.end(JSON.stringify({ error: { message: reply.message ?? `mock error ${reply.status}` } }));
      return;
    }
    if (reply.kind === 'hang') return; // never respond

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let closed = false;
    res.on('close', () => (closed = true));
    const id = `chatcmpl-mock-${requests.length}`;
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    let completion = 0;
    for (let i = 0; i < reply.chunks.length; i++) {
      if (closed) return;
      if (reply.hangAfter !== undefined && i >= reply.hangAfter) return;
      const c = reply.chunks[i]!;
      const delta: Record<string, unknown> = { role: 'assistant' };
      if (c.content !== undefined) delta.content = c.content;
      if (c.reasoning !== undefined) delta.reasoning = c.reasoning;
      if (c.toolCalls) {
        delta.tool_calls = c.toolCalls.map((t, index) => ({
          index,
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments },
        }));
      }
      completion += (c.content ?? '').length;
      send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] });
      if (reply.chunkDelayMs) await delay(reply.chunkDelayMs);
    }
    const hasTools = reply.chunks.some((c) => c.toolCalls?.length);
    send({
      id,
      object: 'chat.completion.chunk',
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? (hasTools ? 'tool_calls' : 'stop') }],
    });
    if (reply.usage !== false) {
      send({
        id,
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: Math.ceil(completion / 4), total_tokens: 10 + Math.ceil(completion / 4) },
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}/v1`,
    requests,
    setScript(s) {
      current = s;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export function textReply(text: string, opts: { chunkSize?: number; chunkDelayMs?: number } = {}): MockReply {
  const size = opts.chunkSize ?? 8;
  const chunks: MockChunk[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push({ content: text.slice(i, i + size) });
  return { kind: 'stream', chunks, chunkDelayMs: opts.chunkDelayMs };
}

export function toolCallReply(name: string, args: unknown, id = `call_${name}`): MockReply {
  return { kind: 'stream', chunks: [{ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }] };
}

/**
 * Deterministic default behaviour used by integration/E2E tests:
 * - JSON-mode requests (router/evaluator/supervisor) get a small JSON document.
 * - When tools are offered and the prompt asks to remember/recall, it calls the memory tools once.
 * - Otherwise it streams a short answer that echoes the user prompt.
 */
export const defaultScript: MockScript = (body) => {
  const last = body.messages[body.messages.length - 1];
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const toolNames = new Set((body.tools ?? []).map((t) => t.function.name));

  if (body.response_format && (body.response_format as { type?: string }).type === 'json_object') {
    const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('evaluat')) return textReply(JSON.stringify({ verdict: 'passed', score: 0.9, issues: [] }));
    if (system.includes('subtasks')) {
      return textReply(JSON.stringify({ subtasks: [{ agent: 'researcher', task: `Research: ${prompt}` }, { agent: 'analyst', task: `Analyse: ${prompt}` }] }));
    }
    return textReply('{}');
  }

  if (last?.role === 'tool') {
    return textReply(`Based on the tool result: ${String(last.content).slice(0, 200)}`, { chunkDelayMs: 5 });
  }
  if (/\btrigger provider failure\b/i.test(prompt)) {
    return { kind: 'error', status: 503, message: 'mock provider outage' };
  }
  if (/\bslow\b/i.test(prompt)) {
    return textReply('This is a deliberately slow streamed answer that keeps going for a while so it can be cancelled.', {
      chunkSize: 3,
      chunkDelayMs: 150,
    });
  }
  if (toolNames.has('search_memory') && /\b(recall|remember|decide|decided)\b/i.test(prompt)) {
    return toolCallReply('search_memory', { query: prompt.replace(/[^\w\s]/g, '').slice(0, 80) });
  }
  if (toolNames.has('calculator') && /\bcalculate\b/i.test(prompt)) {
    const expr = prompt.match(/calculate\s+(.+)/i)?.[1]?.replace(/[^\d+\-*/().\s]/g, '').trim() ?? '1+1';
    return toolCallReply('calculator', { expression: expr });
  }
  return textReply(`NeuroFlow mock answer to: ${prompt}`, { chunkDelayMs: 5 });
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
