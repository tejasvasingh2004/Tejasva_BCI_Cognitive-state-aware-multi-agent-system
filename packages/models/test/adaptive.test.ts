import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdaptiveLimit, DefaultModelGateway, GroqAdapter, ModelError, buildCatalog, createTogetherAdapter, parseResetDuration } from '../src';
import { startMockOpenAIServer, textReply, type MockOpenAIServer } from '../src/testing';

describe('adaptive concurrency limit', () => {
  it('grows while latency stays at its baseline and shrinks when latency climbs', () => {
    const l = new AdaptiveLimit({ initial: 10, min: 2, max: 100 });
    for (let i = 0; i < 50; i++) l.update({ rttMs: 200 });
    const grown = l.limit;
    expect(grown).toBeGreaterThan(10);
    // Requests start queueing at the provider: first-token latency jumps far above the baseline.
    for (let i = 0; i < 30; i++) l.update({ rttMs: 3_000 });
    expect(l.limit).toBeLessThan(grown);
  });

  it('backs off multiplicatively on overload and never goes below the minimum', () => {
    const l = new AdaptiveLimit({ initial: 40, min: 3 });
    l.update({ overloaded: true });
    expect(l.limit).toBe(30);
    for (let i = 0; i < 50; i++) l.update({ overloaded: true });
    expect(l.limit).toBe(3);
  });

  it('holds callers beyond the limit, hands freed slots over in order, and times out to rate_limited', async () => {
    const l = new AdaptiveLimit({ initial: 2, min: 2, max: 2 });
    const a = await l.acquire();
    const b = await l.acquire();
    let thirdIn = false;
    const third = l.acquire(undefined, 5_000).then((release) => {
      thirdIn = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(thirdIn).toBe(false);
    expect(l.snapshot()).toMatchObject({ inflight: 2, waiting: 1 });
    a({ rttMs: 100 });
    const c = await third;
    // The freed slot went to the waiter; a newcomer cannot jump the queue.
    expect(l.snapshot()).toMatchObject({ inflight: 2, waiting: 0 });
    await expect(l.acquire(undefined, 30)).rejects.toMatchObject({ code: 'rate_limited' });
    b({});
    c({});
    expect(l.snapshot().inflight).toBe(0);
  });

  it('parses provider reset durations', () => {
    expect(parseResetDuration('2m59.56s')).toBeCloseTo(179_560);
    expect(parseResetDuration('7.66s')).toBeCloseTo(7_660);
    expect(parseResetDuration('450ms')).toBe(450);
    expect(parseResetDuration('1h')).toBe(3_600_000);
    expect(parseResetDuration('12')).toBe(12_000);
    expect(parseResetDuration('soon')).toBeUndefined();
  });
});

describe("provider rate-limit headers", () => {
  let groq: MockOpenAIServer;
  beforeAll(async () => {
    groq = await startMockOpenAIServer();
  });
  afterAll(async () => {
    await groq.close();
  });

  it("holds further calls on a key the provider reports as exhausted, until the provider's reset", async () => {
    const t = { now: 1_000_000, slept: [] as number[] };
    const gw = new DefaultModelGateway(
      [new GroqAdapter({ baseUrl: groq.url, apiKey: 'k', models: buildCatalog('llama-3.3-70b-versatile') })],
      { baseBackoffMs: 1, maxBackoffMs: 5, maxRetries: 0, maxRateLimitWaitMs: 60_000 },
      { now: () => t.now, sleep: async (ms) => void (t.slept.push(ms), (t.now += ms)) },
    );
    groq.setScript(() => ({ ...textReply('ok'), headers: { 'x-ratelimit-remaining-tokens': '12', 'x-ratelimit-reset-tokens': '7.5s', 'x-ratelimit-remaining-requests': '99' } }));
    await gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'a' }] });
    await new Promise((r) => setTimeout(r, 10));
    groq.setScript(() => textReply('ok'));
    const events: string[] = [];
    for await (const ev of gw.stream({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'b' }] })) events.push(ev.type);
    // The second call waited for the reset the provider announced instead of collecting a 429.
    expect(events).toContain('throttled');
    expect(t.slept.reduce((s, x) => s + x, 0)).toBeGreaterThanOrEqual(7_000);
    expect(events.at(-1)).toBe('done');
  });

  it('a concurrency limit reached for too long fails over instead of queueing forever', async () => {
    const gw = new DefaultModelGateway([new GroqAdapter({ baseUrl: groq.url, apiKey: 'k', models: buildCatalog('llama-3.3-70b-versatile') })], {
      maxRetries: 0,
      maxRateLimitWaitMs: 50,
      adaptiveConcurrency: { initial: 1, min: 1, max: 1 },
    });
    groq.setScript(() => textReply('slow answer', { chunkSize: 2, chunkDelayMs: 40 }));
    const first = gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'one' }] });
    await new Promise((r) => setTimeout(r, 5));
    const second = await gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'two' }] }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ModelError);
    expect((second as ModelError).code).toBe('rate_limited');
    expect((await first).text).toBe('slow answer');
    expect(gw.adaptiveLimits().groq).toMatchObject({ limit: 1, inflight: 0 });
  });
});

describe('hedged first token', () => {
  let slow: MockOpenAIServer;
  let fast: MockOpenAIServer;
  beforeAll(async () => {
    slow = await startMockOpenAIServer();
    fast = await startMockOpenAIServer();
  });
  afterAll(async () => {
    await slow.close();
    await fast.close();
  });
  const gateway = () =>
    new DefaultModelGateway(
      [
        new GroqAdapter({ baseUrl: slow.url, apiKey: 'k', models: buildCatalog('openai/gpt-oss-120b') }),
        createTogetherAdapter({ baseUrl: fast.url, apiKey: 'k', models: buildCatalog('openai/gpt-oss-120b') }),
      ],
      { maxRetries: 0, baseBackoffMs: 1, maxBackoffMs: 2 },
    );
  const ask = [{ role: 'user' as const, content: 'hi' }];

  it('starts the same model on another provider when the first token is late, and keeps whichever answers first', async () => {
    // First content after ~600 ms on the primary; the backup answers at once.
    slow.setScript(() => ({ kind: 'stream', chunks: [{}, {}, { content: 'late answer' }], chunkDelayMs: 300 }));
    fast.setScript(() => textReply('fast answer'));
    const events: Array<{ type: string }> = [];
    const started = Date.now();
    for await (const ev of gateway().stream({ model: 'groq/openai/gpt-oss-120b', messages: ask, hedge: { afterMs: 100 } })) events.push(ev);
    const done = events.find((e) => e.type === 'done') as unknown as { response: { ref: string; text: string; hedge: unknown } };
    expect(done.response).toMatchObject({ ref: 'together/openai/gpt-oss-120b', text: 'fast answer', hedge: { with: 'groq/openai/gpt-oss-120b', won: true } });
    expect(events[0]).toMatchObject({ type: 'hedge', from: 'groq/openai/gpt-oss-120b', to: 'together/openai/gpt-oss-120b', afterMs: 100 });
    // Only the winner's events reach the caller: no attempt event from the cancelled primary.
    expect(events.filter((e) => e.type === 'attempt')).toEqual([expect.objectContaining({ ref: 'together/openai/gpt-oss-120b' })]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('does not hedge when the first token arrives in time, and hands over without hedging when the primary fails first', async () => {
    slow.setScript(() => textReply('quick primary'));
    fast.requests.length = 0;
    const res = await gateway().complete({ model: 'groq/openai/gpt-oss-120b', messages: ask, hedge: { afterMs: 500 } });
    expect(res).toMatchObject({ ref: 'groq/openai/gpt-oss-120b', text: 'quick primary' });
    expect(res.hedge).toBeUndefined();
    expect(fast.requests).toHaveLength(0);

    slow.setScript(() => ({ kind: 'error', status: 503, message: 'down' }));
    fast.setScript(() => textReply('backup'));
    const events: string[] = [];
    let ref = '';
    for await (const ev of gateway().stream({ model: 'groq/openai/gpt-oss-120b', messages: ask, hedge: { afterMs: 2_000 } })) {
      events.push(ev.type);
      if (ev.type === 'done') ref = ev.response.ref;
    }
    expect(ref).toBe('together/openai/gpt-oss-120b');
    expect(events).not.toContain('hedge');
  });
});

describe('admission release', () => {
  let server: MockOpenAIServer;
  beforeAll(async () => {
    server = await startMockOpenAIServer(() => textReply('ok'));
  });
  afterAll(async () => {
    await server.close();
  });

  it('releases the concurrency slot before the final event, even when the caller stops reading there', async () => {
    // One slot: a leaked slot would make the second call wait until it times out.
    const gw = new DefaultModelGateway([new GroqAdapter({ baseUrl: server.url, apiKey: 'k', models: buildCatalog('llama-3.3-70b-versatile') })], {
      maxRetries: 0,
      maxRateLimitWaitMs: 300,
      providerLimits: { groq: { concurrency: 1 } },
      adaptiveConcurrency: false,
    });
    const it = gw.stream({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'a' }] })[Symbol.asyncIterator]();
    for (;;) {
      const { value } = await it.next();
      if (value?.type === 'done') break; // stop reading without draining the generator
    }
    const second = await gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'b' }] });
    expect(second.text).toBe('ok');
  });

  it('releases the losing hedged request', async () => {
    const slow = await startMockOpenAIServer(() => ({ kind: 'stream', chunks: [{}, {}, { content: 'late' }], chunkDelayMs: 200 }));
    try {
      const gw = new DefaultModelGateway(
        [
          new GroqAdapter({ baseUrl: slow.url, apiKey: 'k', models: buildCatalog('openai/gpt-oss-120b') }),
          createTogetherAdapter({ baseUrl: server.url, apiKey: 'k', models: buildCatalog('openai/gpt-oss-120b') }),
        ],
        { maxRetries: 0, maxRateLimitWaitMs: 300, providerLimits: { groq: { concurrency: 1 } }, adaptiveConcurrency: false },
      );
      const first = await gw.complete({ model: 'groq/openai/gpt-oss-120b', messages: [{ role: 'user', content: 'a' }], hedge: { afterMs: 50 } });
      expect(first.ref).toBe('together/openai/gpt-oss-120b');
      // The cancelled Groq request gave its slot back: a direct Groq call gets it.
      await new Promise((r) => setTimeout(r, 50));
      const direct = await gw.complete({ model: 'groq/openai/gpt-oss-120b', messages: [{ role: 'user', content: 'b' }] });
      expect(direct.text).toBe('late');
    } finally {
      await slow.close();
    }
  });
});
