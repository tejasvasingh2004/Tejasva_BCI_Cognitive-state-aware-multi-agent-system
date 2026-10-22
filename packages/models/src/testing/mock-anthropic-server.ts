import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Test double for the Anthropic Messages API (unit and integration tests only). A real HTTP server
 * speaking the streaming wire format, so the official SDK, its event parsing and our adapter run
 * exactly as in production.
 */
export type MockAnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type MockAnthropicReply =
  | { kind: 'message'; blocks: MockAnthropicBlock[]; stopReason?: string }
  | { kind: 'error'; status: number; message?: string; retryAfter?: string };

export type MockAnthropicRequest = {
  model: string;
  system?: string;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  [k: string]: unknown;
};

export type MockAnthropicScript = (body: MockAnthropicRequest, callIndex: number) => MockAnthropicReply;

export type MockAnthropicServer = {
  /** Base URL for the SDK (`baseURL`), without `/v1`. */
  url: string;
  requests: MockAnthropicRequest[];
  /** The API key each request was sent with, parallel to `requests`. */
  keys: string[];
  setValidKeys(keys: string[] | null): void;
  setScript(script: MockAnthropicScript): void;
  close(): Promise<void>;
};

export const defaultAnthropicScript: MockAnthropicScript = (body) => {
  const last = body.messages[body.messages.length - 1];
  const blocks = Array.isArray(last?.content) ? last.content : [];
  if (blocks.some((b) => b.type === 'tool_result')) return { kind: 'message', blocks: [{ type: 'text', text: 'Claude used the tool result.' }] };
  return { kind: 'message', blocks: [{ type: 'thinking', signature: 'sig-0' }, { type: 'text', text: 'Hello from mock Claude.' }] };
};

export async function startMockAnthropicServer(script: MockAnthropicScript = defaultAnthropicScript): Promise<MockAnthropicServer> {
  let current = script;
  const requests: MockAnthropicRequest[] = [];
  const keys: string[] = [];
  let validKeys: Set<string> | null = null;
  const sockets = new Set<Socket>();
  const error = (res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', message } }));
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // SDK 1.x sends Authorization: Bearer; older clients send x-api-key.
    const key = String(req.headers['x-api-key'] ?? '') || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (validKeys && !validKeys.has(key)) return error(res, 401, 'invalid x-api-key');
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as MockAnthropicRequest;
    requests.push(body);
    keys.push(key);
    const reply = current(body, requests.length - 1);
    if (reply.kind === 'error') {
      return error(res, reply.status, reply.message ?? `mock error ${reply.status}`, reply.retryAfter ? { 'retry-after': reply.retryAfter } : {});
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('message_start', {
      message: {
        id: `msg_mock_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    let output = 0;
    reply.blocks.forEach((b, index) => {
      if (b.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (let i = 0; i < b.text.length; i += 8) send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(i, i + 8) } });
        output += Math.ceil(b.text.length / 4);
      } else if (b.type === 'thinking') {
        // Display "omitted": no thinking text, only the signature.
        send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        send('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
        output += 5;
      } else {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
        output += 10;
      }
      send('content_block_stop', { index });
    });
    const stop = reply.stopReason ?? (reply.blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output } });
    send('message_stop', {});
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    keys,
    setValidKeys(list) {
      validKeys = list ? new Set(list) : null;
    },
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
