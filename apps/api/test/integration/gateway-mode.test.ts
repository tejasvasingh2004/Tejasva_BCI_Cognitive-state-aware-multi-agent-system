import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_SCOPES } from '@neuroflow/contracts';
import { authRepo } from '@neuroflow/db';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { startMockAnthropicServer, type MockAnthropicServer } from '@neuroflow/models/testing';
import { api, readSse, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();
const OTHER_KEY = 'nf_gateway_other_ws_key_000000000000';
const CLAUDE_KEY = 'sk-ant-gateway-tenant-key-000000000000';

const overhead = (res: Response) => Number(/overhead;dur=([\d.]+)/.exec(res.headers.get('server-timing') ?? '')?.[1] ?? NaN);
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

/** Gateway mode: single model calls streamed from the API (Phase 2 fast path) and the response cache. */
describe.skipIf(!reachable)('gateway mode', () => {
  let h: Harness;
  let claude: MockAnthropicServer;
  const chat = (body: Record<string, unknown>, init: { key?: string; headers?: Record<string, string> } = {}) =>
    api(h, '/v1/chat/completions', { method: 'POST', json: body, ...init });

  beforeAll(async () => {
    claude = await startMockAnthropicServer();
    h = await startHarness({ ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_MODELS: 'claude-haiku-5-5' });
    const other = await authRepo.ensureUserWithWorkspace(h.db.pool, { email: 'gw-other@example.test', displayName: 'O', workspaceName: 'Other' });
    await authRepo.createApiKey(h.db.pool, { ...other, name: 'o', scopes: [...ALL_SCOPES], key: OTHER_KEY });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    await claude?.close();
  });

  it('answers a single call from the API without queueing a run, and records it afterwards', async () => {
    const before = await h.db.pool.query("SELECT count(*)::int AS n FROM runs WHERE task_class = 'gateway'");
    const res = await chat({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'gateway hello' }], neuroflow: { gateway: true } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-neuroflow-mode')).toBe('gateway');
    expect(overhead(res)).toBeGreaterThanOrEqual(0);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain('gateway hello');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
    expect(body.neuroflow).toMatchObject({ mode: 'gateway' });
    expect(body.neuroflow.cost_usd).toBeGreaterThan(0);

    // Recorded after the response, as a completed direct run with one model call.
    let rows = { rows: [] as Array<{ n: number }> };
    for (let i = 0; i < 40 && !((rows.rows[0]?.n ?? 0) > before.rows[0].n); i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await h.db.pool.query("SELECT count(*)::int AS n FROM runs WHERE task_class = 'gateway'");
    }
    expect(rows.rows[0]!.n).toBe(before.rows[0].n + 1);
    const call = await h.db.pool.query(
      "SELECT r.status, r.output, mc.role, mc.model, mc.cost_usd FROM runs r JOIN model_calls mc ON mc.run_id = r.id WHERE r.task_class = 'gateway' ORDER BY r.created_at DESC LIMIT 1",
    );
    expect(call.rows[0]).toMatchObject({ status: 'completed', role: 'gateway', model: 'groq/llama-3.3-70b-versatile' });
    // No run events were emitted: nothing went through the queue.
    const events = await h.db.pool.query("SELECT count(*)::int AS n FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.task_class = 'gateway'");
    expect(events.rows[0].n).toBe(0);
  });

  it('streams OpenAI chunks with usage when asked, via the header too', async () => {
    const res = await chat({ model: 'groq/llama-3.3-70b-versatile', stream: true, messages: [{ role: 'user', content: 'stream it' }] }, { headers: { 'x-neuroflow-mode': 'gateway' } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const data = await readSse(res);
    expect(data.at(-1)).toBe('[DONE]');
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d));
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(text).toContain('stream it');
    expect(chunks.some((c) => c.choices[0]?.finish_reason === 'stop')).toBe(true);
    expect(chunks.at(-1).usage.total_tokens).toBeGreaterThan(0);
  });

  it("serves a workspace's own key for a provider the server has no key for", async () => {
    claude.setValidKeys([CLAUDE_KEY]);
    expect((await api(h, '/v1/provider-keys', { method: 'POST', json: { provider: 'anthropic', apiKey: CLAUDE_KEY } })).status).toBe(201);
    const res = await chat({ model: 'anthropic/claude-haiku-5-5', messages: [{ role: 'user', content: 'hi claude' }], neuroflow: { gateway: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('Hello from mock Claude.');
    expect(claude.keys.at(-1)).toBe(CLAUDE_KEY);
    // The same model through the full run path is accepted too (it used to be rejected as unknown).
    const run = await chat({ model: 'anthropic/claude-haiku-5-5', messages: [{ role: 'user', content: 'hi again' }] });
    expect(run.status).toBe(200);
  });

  it('reuses an identical single-turn answer from the response cache, per workspace only', async () => {
    const body = { model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'cache me' }], neuroflow: { gateway: true, cache_ttl_seconds: 60 } };
    const providerCalls = () => h.groq.requests.filter((r) => JSON.stringify(r.messages).includes('cache me')).length;
    const first = await chat(body);
    expect(first.headers.get('x-neuroflow-cache')).toBe('miss');
    const a = await first.json();
    const second = await chat(body);
    expect(second.headers.get('x-neuroflow-cache')).toBe('hit');
    const b = await second.json();
    expect(b.choices[0].message.content).toBe(a.choices[0].message.content);
    expect(b.neuroflow.cache).toBe('hit');
    expect(providerCalls()).toBe(1);
    // Another workspace never sees this workspace's cached answer.
    const other = await chat(body, { key: OTHER_KEY });
    expect(other.headers.get('x-neuroflow-cache')).toBe('miss');
    expect(providerCalls()).toBe(2);
    // Multi-turn requests are never cached.
    const multi = await chat({ ...body, messages: [{ role: 'user', content: 'cache me' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'cache me' }] });
    expect(multi.headers.get('x-neuroflow-cache')).toBeNull();
  });

  it('Phase 2 gate: orchestration overhead before the provider request stays under 50 ms at p95', async () => {
    // Warm up connections and caches, then measure what NeuroFlow adds before the model is called.
    for (let i = 0; i < 10; i++) await (await chat({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'warm' }], neuroflow: { gateway: true } })).text();
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const res = await chat({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: `measure ${i}` }], neuroflow: { gateway: true } });
      await res.text();
      samples.push(overhead(res));
    }
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    console.log(`gateway overhead over ${samples.length} calls: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(50);
  }, 120_000);

  it('reaches the first token sooner than the queued run path', async () => {
    const ttft = async (gateway: boolean, i: number) => {
      const started = performance.now();
      const res = await chat(
        { model: 'groq/llama-3.3-70b-versatile', stream: true, messages: [{ role: 'user', content: `first token ${gateway ? 'g' : 'r'}${i}` }], ...(gateway ? { neuroflow: { gateway: true } } : {}) },
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let first: number | undefined;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (first === undefined && /"content":"[^"]+"/.test(buffer)) first = performance.now() - started;
      }
      return first ?? NaN;
    };
    const gateway: number[] = [];
    const queued: number[] = [];
    for (let i = 0; i < 20; i++) {
      gateway.push(await ttft(true, i));
      queued.push(await ttft(false, i));
    }
    const g = percentile(gateway, 50);
    const q = percentile(queued, 50);
    console.log(`time to first token, p50 over 20 calls: gateway mode ${g.toFixed(1)} ms, queued run ${q.toFixed(1)} ms`);
    expect(g).toBeLessThan(q);
  }, 120_000);
});
