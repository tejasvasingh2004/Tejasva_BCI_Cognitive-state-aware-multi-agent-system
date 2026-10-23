import { describe, expect, it } from 'vitest';
import type { Run as ServerRun, RunEvent as ServerRunEvent, RunRequestInput } from '@neuroflow/contracts';
import { NeuroFlow, NeuroFlowError, signWebhook, verifyWebhook, WebhookVerificationError, type Run, type RunEvent, type RunRequest } from '../src/index.js';

// Compile-time: the SDK's types accept what the server returns, and the server accepts what the SDK sends.
const _run = (r: ServerRun): Run => r;
const _event = (e: ServerRunEvent): RunEvent => e;
const _request = (r: RunRequest & { messages: Array<{ role: 'user'; content: string }> }): RunRequestInput => r as RunRequestInput;
void [_run, _event, _request];

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A scripted fetch: each call returns the next response in the list. */
function scripted(responses: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})), ...(init?.body ? { body: String(init.body) } : {}) };
    calls.push(call);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected request ${call.method} ${call.url}`);
    return next(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const sse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const ev = (seq: number, type: string, data: unknown = {}) => `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ runId: 'r1', seq, ts: 't', type, data })}\n\n`;
const runBody = (status: string, output: string | null = null) => ({ run: { id: 'r1', status, output } });

describe('NeuroFlow client', () => {
  it('sends the API key, retries rate limits and server errors (honouring Retry-After) with the same idempotency key', async () => {
    const { impl, calls } = scripted([
      () => json(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '0' }),
      () => json(503, { error: { code: 'unavailable', message: 'busy' } }),
      () => json(201, { run: { id: 'r1' }, conversationId: 'c1', eventsUrl: '/v1/runs/r1/events' }),
    ]);
    const nf = new NeuroFlow({ apiKey: 'nf_test', baseUrl: 'https://api.test/', fetch: impl, maxRetries: 2 });
    const res = await nf.runs.create({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.run.id).toBe('r1');
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('https://api.test/v1/runs');
    expect(calls[0]!.headers.authorization).toBe('Bearer nf_test');
    const keys = new Set(calls.map((c) => c.headers['idempotency-key']));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not retry client errors and exposes the API error', async () => {
    const { impl } = scripted([() => json(429, { error: { code: 'quota_exceeded', message: 'Monthly limit reached', details: { limitUsd: 5 } } }, { 'x-request-id': 'req-9' })]);
    const nf = new NeuroFlow({ apiKey: 'k', fetch: impl, maxRetries: 0 });
    const err = (await nf.runs.get('r1').catch((e: unknown) => e)) as NeuroFlowError;
    expect(err).toBeInstanceOf(NeuroFlowError);
    expect(err).toMatchObject({ status: 429, code: 'quota_exceeded', message: 'Monthly limit reached', details: { limitUsd: 5 }, requestId: 'req-9' });

    const notFound = scripted([() => json(404, { error: { code: 'not_found', message: 'Run not found' } })]);
    const nf2 = new NeuroFlow({ apiKey: 'k', fetch: notFound.impl, maxRetries: 3 });
    await expect(nf2.runs.get('missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(notFound.calls).toHaveLength(1);
  });

  it('streams events across chunk boundaries, skips heartbeats, and resumes a dropped stream without repeats', async () => {
    const first = ev(1, 'run.started') + ev(2, 'response.delta', { text: 'Hel' });
    const { impl, calls } = scripted([
      // Split mid-event and include a heartbeat comment.
      () => sse([first.slice(0, 30), first.slice(30), ': ping\n\n', ev(3, 'response.delta', { text: 'lo' }).slice(0, 25)]),
      // Reconnected: the server replays from Last-Event-ID (2), including an event already seen.
      (call) => {
        expect(call.headers['last-event-id']).toBe('2');
        return sse([ev(2, 'response.delta', { text: 'Hel' }), ev(3, 'response.delta', { text: 'lo' }), ev(4, 'run.completed', { durationMs: 5 })]);
      },
    ]);
    const nf = new NeuroFlow({ apiKey: 'k', fetch: impl });
    const seen: string[] = [];
    for await (const e of nf.runs.events('r1')) seen.push(`${e.seq}:${e.type}`);
    expect(seen).toEqual(['1:run.started', '2:response.delta', '3:response.delta', '4:run.completed']);
    expect(calls).toHaveLength(2);
  });

  it('waits for a run, answering approvals through the callback', async () => {
    const { impl, calls } = scripted([
      () =>
        sse([
          ev(1, 'approval.requested', { toolCallId: 'tc1', name: 'commit', riskLevel: 'high', arguments: {}, expiresAt: 'x' }),
          ev(2, 'response.delta', { text: 'Done' }),
          ev(3, 'run.completed', { durationMs: 1 }),
        ]),
      (call) => {
        expect(call.url).toMatch(/\/v1\/runs\/r1\/approvals$/);
        expect(JSON.parse(call.body!)).toEqual({ toolCallId: 'tc1', approved: true, reason: 'looks fine' });
        return json(200, { ok: true });
      },
      () => json(200, runBody('completed', 'Done')),
    ]);
    const nf = new NeuroFlow({ apiKey: 'k', fetch: impl });
    const approvals: string[] = [];
    const run = await nf.runs.wait('r1', {
      onApproval: (req) => {
        approvals.push(`${req.runId}:${req.name}`);
        return { approved: true, reason: 'looks fine' };
      },
    });
    expect(run).toMatchObject({ status: 'completed', output: 'Done' });
    expect(approvals).toEqual(['r1:commit']);
    expect(calls).toHaveLength(3);
  });

  it('streams the answer text and returns the final run', async () => {
    const { impl } = scripted([
      () => json(201, { run: { id: 'r1' }, conversationId: 'c', eventsUrl: '' }),
      () => sse([ev(1, 'response.delta', { text: 'Hello ' }), ev(2, 'response.delta', { text: 'world' }), ev(3, 'run.completed', { durationMs: 1 })]),
      () => json(200, runBody('completed', 'Hello world')),
    ]);
    const nf = new NeuroFlow({ apiKey: 'k', fetch: impl });
    const stream = nf.runs.stream({ messages: [{ role: 'user', content: 'hi' }] });
    let text = '';
    let result = await stream.next();
    while (!result.done) {
      text += result.value;
      result = await stream.next();
    }
    expect(text).toBe('Hello world');
    expect(result.value.output).toBe('Hello world');
  });

  it('reports timeouts and network failures as retryable errors', async () => {
    const nf = new NeuroFlow({
      apiKey: 'k',
      maxRetries: 0,
      timeoutMs: 20,
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch,
    });
    await expect(nf.runs.get('r1')).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});

describe('webhook verification', () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const body = '{"test": 2432232314}';
  const at = 1614265330;

  it('matches the Standard Webhooks reference signature and returns the event', async () => {
    expect(await signWebhook(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', at, body)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    const headers = new Headers({ 'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek', 'webhook-timestamp': String(at), 'webhook-signature': 'v1,old v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' });
    expect(await verifyWebhook(secret, headers, body, { now: at * 1000 })).toEqual({ test: 2432232314 });
    // Node-style header objects work too.
    expect(await verifyWebhook(secret, Object.fromEntries(headers), body, { now: at * 1000 })).toEqual({ test: 2432232314 });
  });

  it('rejects a tampered body, a stale timestamp and missing headers', async () => {
    const sig = await signWebhook(secret, 'm1', at, body);
    const headers = { 'webhook-id': 'm1', 'webhook-timestamp': String(at), 'webhook-signature': sig };
    await expect(verifyWebhook(secret, headers, '{"test": 1}', { now: at * 1000 })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyWebhook(secret, headers, body, { now: (at + 600) * 1000 })).rejects.toThrow(/tolerance/);
    await expect(verifyWebhook(secret, {}, body)).rejects.toThrow(/Missing/);
  });
});
