/**
 * Standalone mock OpenAI-compatible provider for load tests (never for production). Streams the
 * default test answers with a per-chunk delay so each model call takes a realistic ~1 s, without
 * spending provider tokens.
 *
 *   MOCK_PORT=11500 MOCK_HOST=0.0.0.0 MOCK_CHUNK_DELAY_MS=150 node --import tsx packages/models/src/testing/serve.ts
 */
import { defaultScript, startMockOpenAIServer, type MockScript } from './mock-openai-server';

const port = Number(process.env.MOCK_PORT ?? 11500);
const host = process.env.MOCK_HOST ?? '0.0.0.0';
const chunkDelayMs = Number(process.env.MOCK_CHUNK_DELAY_MS ?? 150);

const script: MockScript = (body, i) => {
  const reply = defaultScript(body, i);
  return reply.kind === 'stream' ? { ...reply, chunkDelayMs, usage: true } : reply;
};

const server = await startMockOpenAIServer(script, port, host);
console.log(`mock provider listening on ${host}:${port} (chunk delay ${chunkDelayMs} ms)`);
let last = 0;
setInterval(() => {
  const n = server.requests.length;
  if (n !== last) console.log(`model calls served: ${n} (+${n - last})`);
  last = n;
}, 10_000).unref();
const stop = () => void server.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
