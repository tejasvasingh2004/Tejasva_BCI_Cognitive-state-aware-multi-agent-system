import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultScript, textReply } from '@neuroflow/models/testing';
import { authRepo } from '@neuroflow/db';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { api, readSse, runEvents, startHarness, text, type Harness } from './harness';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('vertical slice: API → queue → worker → orchestrator → gateway → SSE', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    h.qwen.setScript(defaultScript);
    h.groq.setScript(defaultScript);
  });

  it('health and readiness', async () => {
    expect((await api(h, '/health', { key: null })).status).toBe(200);
    const ready = await (await api(h, '/ready', { key: null })).json();
    expect(ready).toMatchObject({ status: 'ready', checks: { database: 'ok', redis: 'ok', models: 'ok' } });
  });

  it('rejects unauthenticated and invalid credentials with the error contract', async () => {
    const noAuth = await api(h, '/v1/conversations', { key: null });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect((await api(h, '/v1/conversations', { key: 'nf_bogus' })).status).toBe(401);
  });

  it('validates requests', async () => {
    const res = await api(h, '/v1/runs', { method: 'POST', json: { messages: [] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request', details: expect.any(Array) } });
  });

  it('creates a durable run immediately and streams real execution events to completion', async () => {
    const t0 = Date.now();
    const res = await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'hello there' }] } });
    const ackMs = Date.now() - t0;
    expect(res.status).toBe(201);
    const { run, conversationId } = await res.json();
    expect(run.status).toBe('queued');
    expect(ackMs).toBeLessThan(2000);

    const events = await runEvents(h, run.id);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.created');
    expect(types).toEqual(expect.arrayContaining(['run.queued', 'run.started', 'router.selected', 'model.started', 'response.delta', 'model.completed', 'evaluation.completed']));
    expect(types.at(-1)).toBe('run.completed');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(text(events)).toBe('NeuroFlow mock answer to: hello there');

    const detail = await (await api(h, `/v1/runs/${run.id}`)).json();
    expect(detail.run).toMatchObject({ status: 'completed', output: 'NeuroFlow mock answer to: hello there' });
    expect(detail.run.executionPlan.agentStrategy).toBeDefined();
    expect(detail.details.modelCalls[0]).toMatchObject({ provider: 'qwen', status: 'completed' });

    const conv = await (await api(h, `/v1/conversations/${conversationId}`)).json();
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(conv.conversation.title).toBe('hello there');
  });

  it('replays events after reconnect using Last-Event-ID', async () => {
    const { run } = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'hi' }] } })).json();
    const all = await runEvents(h, run.id);
    const resumed = await readSse(await api(h, `/v1/runs/${run.id}/events`, { headers: { 'last-event-id': '3' } }));
    expect(resumed.map((d) => JSON.parse(d).seq)).toEqual(all.filter((e) => e.seq > 3).map((e) => e.seq));
  });

  it('continues a conversation with server-side history', async () => {
    const first = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'first question' }] } })).json();
    await runEvents(h, first.run.id);
    const second = await api(h, `/v1/conversations/${first.conversationId}/runs`, {
      method: 'POST',
      json: { messages: [{ role: 'user', content: 'follow up' }] },
    });
    expect(second.status).toBe(201);
    const { run } = await second.json();
    await runEvents(h, run.id);
    const lastRequest = h.qwen.requests.at(-1)!;
    const contents = lastRequest.messages.map((m) => m.content);
    expect(contents).toEqual(expect.arrayContaining(['first question', 'NeuroFlow mock answer to: first question', 'follow up']));
  });

  it('is idempotent with Idempotency-Key', async () => {
    const body = { method: 'POST', json: { messages: [{ role: 'user', content: 'once' }] }, headers: { 'idempotency-key': 'abc-123' } };
    const a = await api(h, '/v1/runs', body);
    const b = await api(h, '/v1/runs', body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect((await a.json()).run.id).toBe((await b.json()).run.id);
  });

  it('executes tools and memory through the runtime (model decides)', async () => {
    await api(h, '/v1/memories', { method: 'POST', json: { content: 'We decided the pricing is $29 per seat', tags: ['pricing'] } });
    const { run } = await (
      await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'What did I decide about pricing?' }] } })
    ).json();
    const events = await runEvents(h, run.id);
    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['tool.started', 'memory.started', 'memory.completed', 'tool.completed']));
    expect(text(events)).toContain('$29');
    const detail = await (await api(h, `/v1/runs/${run.id}`)).json();
    expect(detail.details.toolCalls[0]).toMatchObject({ name: 'search_memory', status: 'success' });
  });

  it('cancels a running task and stops the stream', async () => {
    const { run } = await (
      await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'please be slow' }], agentStrategy: 'direct' } })
    ).json();
    let cancelled = false;
    const events = await runEvents(h, run.id, (e) => {
      if (e.type === 'response.delta' && !cancelled) {
        cancelled = true;
        void api(h, `/v1/runs/${run.id}/cancel`, { method: 'POST' });
      }
    });
    expect(events.at(-1)!.type).toBe('run.cancelled');
    const detail = await (await api(h, `/v1/runs/${run.id}`)).json();
    expect(detail.run.status).toBe('cancelled');
    expect(detail.run.output.length).toBeLessThan(90);
  });

  it('falls back across providers and reports clear failures', async () => {
    h.qwen.setScript(() => ({ kind: 'error', status: 503 }));
    h.groq.setScript(() => textReply('answer from fallback provider'));
    const ok = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'hello' }] } })).json();
    const events = await runEvents(h, ok.run.id);
    expect(events.map((e) => e.type)).toContain('model.fallback');
    expect(text(events)).toBe('answer from fallback provider');

    h.groq.setScript(() => ({ kind: 'error', status: 500 }));
    const bad = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'hello' }] } })).json();
    const failed = await runEvents(h, bad.run.id);
    const last = failed.at(-1)!;
    expect(last.type).toBe('run.failed');
    if (last.type === 'run.failed') {
      expect(last.data.error.code).toBe('model_unavailable');
      expect(last.data.error.message).not.toContain('127.0.0.1');
    }
  });

  it('isolates workspaces', async () => {
    const { run } = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'mine' }] } })).json();
    const other = await authRepo.ensureUserWithWorkspace(h.db.pool, { email: 'intruder@x.io', displayName: 'I', workspaceName: 'I' });
    const { key } = await authRepo.createApiKey(h.db.pool, { ...other, name: 'k', scopes: ['runs:read', 'runs:write'] });
    expect((await api(h, `/v1/runs/${run.id}`, { key })).status).toBe(404);
    expect((await api(h, `/v1/runs/${run.id}/events`, { key })).status).toBe(404);
    expect((await api(h, `/v1/runs/${run.id}/cancel`, { method: 'POST', key })).status).toBe(404);
  });

  it('OpenAI-compatible: non-streaming', async () => {
    const res = await api(h, '/v1/chat/completions', {
      method: 'POST',
      json: { model: 'neuroflow-auto', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'ping' }] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'NeuroFlow mock answer to: ping' }, finish_reason: 'stop' }],
      usage: { total_tokens: expect.any(Number) },
    });
    expect(body.neuroflow.run_id).toBeDefined();
    // Client system prompt is honoured inside NeuroFlow's system instructions.
    expect(h.qwen.requests.at(-1)!.messages[0]!.content).toContain('Be brief.');
  });

  it('OpenAI-compatible: streaming chunks and unknown models', async () => {
    const res = await api(h, '/v1/chat/completions', {
      method: 'POST',
      json: { model: 'qwen/qwen3:8b', stream: true, messages: [{ role: 'user', content: 'stream please' }] },
    });
    const frames = await readSse(res);
    expect(frames.at(-1)).toBe('[DONE]');
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
    expect(chunks[0].object).toBe('chat.completion.chunk');
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(content).toBe('NeuroFlow mock answer to: stream please');
    expect(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);

    const unknown = await api(h, '/v1/chat/completions', { method: 'POST', json: { model: 'gpt-9', messages: [{ role: 'user', content: 'x' }] } });
    expect(unknown.status).toBe(404);
  });

  it('lists models (OpenAI format) with availability', async () => {
    const body = await (await api(h, '/v1/models')).json();
    expect(body.object).toBe('list');
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(['neuroflow-auto', 'qwen/qwen3:8b', 'groq/llama-3.3-70b-versatile']);
  });

  it('recovers a run interrupted by worker shutdown', async () => {
    const { run } = await (
      await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'slow recovery test' }], agentStrategy: 'direct' } })
    ).json();
    let interrupted = false;
    const events = await runEvents(h, run.id, (e) => {
      if (e.type === 'response.delta' && !interrupted) {
        interrupted = true;
        h.shutdown.abort();
        setTimeout(() => void h.restartWorker(), 300);
      }
    });
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'run.started')).toHaveLength(2);
    expect(types).toContain('response.reset');
    expect(types.at(-1)).toBe('run.completed');
    const detail = await (await api(h, `/v1/runs/${run.id}`)).json();
    expect(detail.run.attempt).toBe(2);
    expect(detail.run.output).toBe(text(events));
  }, 30_000);
});
