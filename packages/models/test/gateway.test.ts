import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DefaultModelGateway,
  GroqAdapter,
  ModelError,
  QwenAdapter,
  buildCatalog,
  stripThinking,
  ThinkFilter,
  type ModelEvent,
  type ProviderAdapter,
} from '../src';
import { defaultScript as defaultScriptRef, startMockOpenAIServer, textReply, type MockOpenAIServer } from '../src/testing';

let qwen: MockOpenAIServer;
let groq: MockOpenAIServer;

beforeAll(async () => {
  qwen = await startMockOpenAIServer();
  groq = await startMockOpenAIServer();
});
afterAll(async () => {
  await qwen.close();
  await groq.close();
});
/** Virtual clock: the gateway's sleeps advance time instead of waiting. */
function virtualTime() {
  const t = { now: 1_000_000, slept: [] as number[] };
  return {
    t,
    opts: {
      now: () => t.now,
      sleep: async (ms: number) => {
        t.slept.push(ms);
        t.now += ms;
      },
    },
  };
}

beforeEach(() => {
  qwen.requests.length = 0;
  groq.requests.length = 0;
});

function gateway(policy: Partial<ConstructorParameters<typeof DefaultModelGateway>[1]> = {}) {
  return new DefaultModelGateway(
    [
      new QwenAdapter({ baseUrl: qwen.url, flavor: 'ollama', models: buildCatalog('qwen3:8b', 'toggle') }),
      new GroqAdapter({ baseUrl: groq.url, apiKey: 'test-key', models: buildCatalog('llama-3.3-70b-versatile,qwen/qwen3-32b') }),
    ],
    { baseBackoffMs: 1, maxBackoffMs: 5, ...policy },
    { sleep: async () => {} },
  );
}

async function collect(it: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const ev of it) events.push(ev);
  return events;
}

const user = [{ role: 'user' as const, content: 'hello' }];

describe('ModelGateway', () => {
  it('streams deltas and returns a normalised response', async () => {
    qwen.setScript(() => textReply('Hello from Qwen', { chunkSize: 4 }));
    const events = await collect(gateway().stream({ model: 'qwen/qwen3:8b', messages: user }));
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Hello from Qwen');
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.response.provider).toBe('qwen');
      expect(done.response.finishReason).toBe('stop');
      expect(done.response.usage?.totalTokens).toBeGreaterThan(0);
      expect(done.response.attempts).toBe(1);
    }
  });

  it('never surfaces provider reasoning fields or <think> content', async () => {
    qwen.setScript(() => ({
      kind: 'stream',
      chunks: [
        { reasoning: 'secret chain of thought' },
        { content: '<thi' },
        { content: 'nk>hidden plan</think>\n\nVisible' },
        { content: ' answer' },
      ],
    }));
    const res = await gateway().complete({ model: 'qwen/qwen3:8b', messages: user });
    expect(res.text).toBe('Visible answer');
    expect(res.text).not.toContain('secret');
  });

  it('maps reasoning budget per provider', async () => {
    qwen.setScript(() => textReply('ok'));
    groq.setScript(() => textReply('ok'));
    const gw = gateway();
    await gw.complete({ model: 'qwen/qwen3:8b', messages: user, reasoningBudget: 'off' });
    await gw.complete({ model: 'qwen/qwen3:8b', messages: user, reasoningBudget: 'high' });
    await gw.complete({ model: 'groq/qwen/qwen3-32b', messages: user, reasoningBudget: 'medium' });
    await gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: user, reasoningBudget: 'high' });
    expect(qwen.requests[0]!.reasoning_effort).toBe('none');
    expect(qwen.requests[1]!.reasoning_effort).toBe('high');
    expect(groq.requests[0]!.reasoning_format).toBe('hidden');
    expect(groq.requests[0]!.reasoning_effort).toBe('default');
    expect(groq.requests[1]!.reasoning_effort).toBeUndefined();
  });

  it('assembles tool calls', async () => {
    qwen.setScript(() => ({
      kind: 'stream',
      chunks: [{ toolCalls: [{ id: 'c1', name: 'search_memory', arguments: '{"query":"pricing"}' }] }],
    }));
    const res = await gateway().complete({
      model: 'qwen/qwen3:8b',
      messages: user,
      tools: [{ name: 'search_memory', description: 'search', inputSchema: { type: 'object' } }],
    });
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'search_memory', arguments: '{"query":"pricing"}' }]);
    expect(qwen.requests[0]!.tools).toHaveLength(1);
  });

  it('retries retryable errors before output', async () => {
    qwen.setScript((_b, i) => (i < 2 ? { kind: 'error', status: 503 } : textReply('recovered')));
    const events = await collect(gateway().stream({ model: 'qwen/qwen3:8b', messages: user }));
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.response.text).toBe('recovered');
    expect(done?.type === 'done' && done.response.attempts).toBe(3);
  });

  it('honours a provider retry-after by holding that key, then retries', async () => {
    const { t, opts } = virtualTime();
    const gw = new DefaultModelGateway(
      [new GroqAdapter({ baseUrl: groq.url, apiKey: 'test-key', models: buildCatalog('llama-3.3-70b-versatile') })],
      { baseBackoffMs: 1, maxBackoffMs: 5, maxRateLimitWaitMs: 60_000 },
      opts,
    );
    groq.setScript((_b, i) =>
      i === 0 ? { kind: 'error', status: 429, message: 'Rate limit reached on tokens per minute (TPM). Please try again in 39.12s.' } : textReply('ok'),
    );
    const events = await collect(gw.stream({ model: 'groq/llama-3.3-70b-versatile', messages: user }));
    expect(events.at(-1)?.type).toBe('done');
    // Hint parsed from the message; the wait happens once, as a throttle before the next send.
    expect(t.slept).toEqual([39_120]);
    expect(events.some((e) => e.type === 'throttled')).toBe(true);
  });

  it('falls back instead of waiting longer than the rate-limit wait cap', async () => {
    const { t, opts } = virtualTime();
    const gw = new DefaultModelGateway(
      [
        new GroqAdapter({ baseUrl: groq.url, apiKey: 'test-key', models: buildCatalog('llama-3.3-70b-versatile') }),
        new QwenAdapter({ baseUrl: qwen.url, flavor: 'ollama', models: buildCatalog('qwen3:8b', 'toggle') }),
      ],
      { baseBackoffMs: 1, maxBackoffMs: 5, maxRateLimitWaitMs: 60_000 },
      opts,
    );
    groq.setScript(() => ({ kind: 'error', status: 429, message: 'slow down', retryAfter: '120' }));
    qwen.setScript(() => textReply('from qwen'));
    const res = await gw.complete({ model: 'groq/llama-3.3-70b-versatile', fallbacks: ['qwen/qwen3:8b'], messages: user });
    expect(res.text).toBe('from qwen');
    expect(t.slept).toEqual([]);
    expect(groq.requests).toHaveLength(1);
  });

  it('does not retry non-retryable errors, but falls back to another provider', async () => {
    qwen.setScript(() => ({ kind: 'error', status: 400, message: 'bad' }));
    groq.setScript(() => textReply('from groq'));
    const events = await collect(
      gateway().stream({ model: 'qwen/qwen3:8b', fallbacks: ['groq/llama-3.3-70b-versatile'], messages: user }),
    );
    expect(qwen.requests).toHaveLength(1);
    expect(events.some((e) => e.type === 'fallback')).toBe(true);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.response.provider).toBe('groq');
    expect(done?.type === 'done' && done.response.fallbackFrom).toBe('qwen/qwen3:8b');
  });

  it('fails clearly when all options are exhausted', async () => {
    qwen.setScript(() => ({ kind: 'error', status: 401 }));
    await expect(gateway().complete({ model: 'qwen/qwen3:8b', messages: user })).rejects.toMatchObject({
      code: 'auth',
    });
  });

  it('skips unconfigured providers and unknown models', async () => {
    const gw = new DefaultModelGateway([
      new GroqAdapter({ models: buildCatalog('llama-3.3-70b-versatile') }), // no api key
    ]);
    await expect(gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: user })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(gw.complete({ model: 'groq/nope', messages: user })).rejects.toMatchObject({ code: 'model_not_found' });
    // A key-based provider without any key is offered in Settings, not listed as models.
    expect(gw.listModels()).toEqual([]);
  });

  it('times out when the first token never arrives', async () => {
    qwen.setScript(() => ({ kind: 'hang' }));
    await expect(
      gateway({ firstTokenTimeoutMs: 100, maxRetries: 0 }).complete({ model: 'qwen/qwen3:8b', messages: user }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('does not retry once output has been streamed', async () => {
    qwen.setScript(() => ({ kind: 'stream', chunks: [{ content: 'partial' }, { content: 'never' }], hangAfter: 1 }));
    await expect(
      gateway({ idleTimeoutMs: 100 }).complete({ model: 'qwen/qwen3:8b', messages: user }),
    ).rejects.toMatchObject({ code: 'interrupted', retryable: false });
    expect(qwen.requests).toHaveLength(1);
  });

  it('propagates cancellation through AbortSignal', async () => {
    qwen.setScript(() => textReply('a long answer that streams slowly', { chunkSize: 2, chunkDelayMs: 30 }));
    const controller = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const ev of gateway().stream({ model: 'qwen/qwen3:8b', messages: user, signal: controller.signal })) {
        if (ev.type === 'delta') {
          seen.push(ev.text);
          if (seen.length === 2) controller.abort();
        }
      }
    })();
    await expect(run).rejects.toBeInstanceOf(ModelError);
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen.length).toBeLessThan(10);
  });
});

describe('ThinkFilter', () => {
  it('handles tags split across chunks', () => {
    const f = new ThinkFilter();
    const out = ['Hi <th', 'ink>x', 'yz</th', 'ink> there'].map((c) => f.push(c)).join('') + f.flush();
    expect(out).toBe('Hi  there');
  });

  it('discards unterminated think blocks', () => {
    expect(stripThinking('<think>never closed')).toBe('');
    expect(stripThinking('a < b')).toBe('a < b');
  });
});

describe('ModelGateway cost and concurrency', () => {
  it('attaches estimated cost from catalog pricing or overrides', async () => {
    groq.setScript(() => textReply('priced answer'));
    const res = await gateway().complete({ model: 'groq/llama-3.3-70b-versatile', messages: user });
    const u = res.usage!;
    expect(u.costUsd).toBeCloseTo((u.promptTokens * 0.59 + u.completionTokens * 0.79) / 1e6, 6);

    const overridden = await gateway({
      pricing: new Map([['groq/llama-3.3-70b-versatile', { inputPerMTok: 1000, outputPerMTok: 1000 }]]),
    }).complete({ model: 'groq/llama-3.3-70b-versatile', messages: user });
    expect(overridden.usage!.costUsd).toBeCloseTo(overridden.usage!.totalTokens / 1000, 6);
    expect(gateway().listModels().find((m) => m.ref === 'groq/llama-3.3-70b-versatile')?.pricing).toEqual({
      inputPerMTok: 0.59,
      outputPerMTok: 0.79,
    });
  });

  /** Provider stub that holds each stream open for `ms` and records peak concurrency. */
  function slowProvider(ms: number) {
    const stats = { inFlight: 0, peak: 0 };
    const adapter: ProviderAdapter = {
      id: 'slow',
      displayName: 'Slow',
      catalog: () => buildCatalog('m1'),
      isAvailable: () => true,
      async *stream() {
        stats.inFlight++;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        try {
          await new Promise((r) => setTimeout(r, ms));
          yield { type: 'delta' as const, text: 'ok' };
          yield { type: 'finish' as const, reason: 'stop' as const };
        } finally {
          stats.inFlight--;
        }
      },
    };
    return { adapter, stats };
  }

  it('limits concurrent attempts per provider', async () => {
    const { adapter, stats } = slowProvider(30);
    const gw = new DefaultModelGateway([adapter], { providerConcurrency: { slow: 1 } });
    const results = await Promise.all([1, 2, 3].map(() => gw.complete({ model: 'slow/m1', messages: user })));
    expect(results.map((r) => r.text)).toEqual(['ok', 'ok', 'ok']);
    expect(stats.peak).toBe(1);

    const unlimited = slowProvider(30);
    const gw2 = new DefaultModelGateway([unlimited.adapter]);
    await Promise.all([1, 2, 3].map(() => gw2.complete({ model: 'slow/m1', messages: user })));
    expect(unlimited.stats.peak).toBe(3);
  });

  it('a queued call can be cancelled while waiting for a slot', async () => {
    const { adapter } = slowProvider(60);
    const gw = new DefaultModelGateway([adapter], { providerConcurrency: { slow: 1 } });
    const first = gw.complete({ model: 'slow/m1', messages: user });
    const ctrl = new AbortController();
    const second = gw.complete({ model: 'slow/m1', messages: user, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    await expect(first).resolves.toMatchObject({ text: 'ok' });
  });

  describe('provider budgets, key pools and circuit breaker', () => {
    /** Adapter that records which key served each call and can be told to fail. */
    function pooledProvider(opts: { keys?: number; fail?: () => boolean; tokens?: number } = {}) {
      const calls: number[] = [];
      const adapter: ProviderAdapter = {
        id: 'pool',
        displayName: 'Pool',
        catalog: () => buildCatalog('m1|strong'),
        isAvailable: () => true,
        keyCount: () => opts.keys ?? 1,
        async *stream(req) {
          calls.push(req.keyIndex ?? 0);
          if (opts.fail?.()) throw new ModelError('unavailable', 'provider down');
          yield { type: 'delta' as const, text: 'ok' };
          yield { type: 'usage' as const, usage: { promptTokens: (opts.tokens ?? 1000) - 10, completionTokens: 10, totalTokens: opts.tokens ?? 1000 } };
          yield { type: 'finish' as const, reason: 'stop' as const };
        },
      };
      return { adapter, calls };
    }

    it('waits for tokens-per-minute budget before sending, and corrects it with real usage', async () => {
      const { t, opts } = virtualTime();
      const { adapter, calls } = pooledProvider({ tokens: 3_990 });
      const gw = new DefaultModelGateway([adapter], { providerLimits: { pool: { tokensPerMinute: 4_000 } } }, opts);
      await gw.complete({ model: 'pool/m1', messages: user, maxOutputTokens: 100 });
      expect(t.slept).toEqual([]);
      // 3 990 of 4 000 tokens were really used, so the next call waits for the bucket to refill.
      const events = await collect(gw.stream({ model: 'pool/m1', messages: user, maxOutputTokens: 100 }));
      expect(events.some((e) => e.type === 'throttled')).toBe(true);
      expect(t.slept.length).toBe(1);
      expect(t.slept[0]).toBeGreaterThan(0);
      expect(calls).toHaveLength(2);
    });

    it('spreads calls across a key pool before waiting', async () => {
      const { t, opts } = virtualTime();
      const { adapter, calls } = pooledProvider({ keys: 2 });
      const gw = new DefaultModelGateway([adapter], { providerLimits: { pool: { requestsPerMinute: 1 } } }, opts);
      await gw.complete({ model: 'pool/m1', messages: user });
      await gw.complete({ model: 'pool/m1', messages: user });
      expect(new Set(calls)).toEqual(new Set([0, 1]));
      expect(t.slept).toEqual([]);
      await gw.complete({ model: 'pool/m1', messages: user });
      expect(t.slept).toHaveLength(1);
    });

    it('opens the circuit after repeated failures, skips the provider, then recovers through a trial request', async () => {
      const { t, opts } = virtualTime();
      let down = true;
      const { adapter, calls } = pooledProvider({ fail: () => down });
      const gw = new DefaultModelGateway(
        [adapter],
        { maxRetries: 0, circuitBreaker: { failureThreshold: 3, openMs: 30_000, maxOpenMs: 120_000 } },
        opts,
      );
      for (let i = 0; i < 3; i++) await expect(gw.complete({ model: 'pool/m1', messages: user })).rejects.toMatchObject({ code: 'unavailable' });
      expect(gw.circuits().pool?.state).toBe('open');
      expect(gw.listModels().find((m) => m.ref === 'pool/m1')?.available).toBe(false);
      // While open, no request reaches the provider.
      await expect(gw.complete({ model: 'pool/m1', messages: user })).rejects.toThrow(/circuit open/);
      expect(calls).toHaveLength(3);

      t.now += 30_000;
      expect(gw.circuits().pool?.state).toBe('half_open');
      down = false;
      await expect(gw.complete({ model: 'pool/m1', messages: user })).resolves.toMatchObject({ text: 'ok' });
      expect(gw.circuits().pool?.state).toBe('closed');
    });

    it('a failed trial re-opens the circuit for longer', async () => {
      const { t, opts } = virtualTime();
      const { adapter } = pooledProvider({ fail: () => true });
      const gw = new DefaultModelGateway([adapter], { maxRetries: 0, circuitBreaker: { failureThreshold: 1, openMs: 10_000, maxOpenMs: 60_000 } }, opts);
      await expect(gw.complete({ model: 'pool/m1', messages: user })).rejects.toBeTruthy();
      t.now += 10_000;
      await expect(gw.complete({ model: 'pool/m1', messages: user })).rejects.toBeTruthy();
      t.now += 10_000;
      expect(gw.circuits().pool?.state).toBe('open');
      t.now += 10_000;
      expect(gw.circuits().pool?.state).toBe('half_open');
    });
  });
});

describe('workspace keys (BYOK)', () => {
  const tenantGroq = (key = 'test-key') =>
    new DefaultModelGateway(
      [new GroqAdapter({ baseUrl: groq.url, apiKey: key, models: buildCatalog('llama-3.3-70b-versatile') })],
      { baseBackoffMs: 1, maxBackoffMs: 5 },
      { sleep: async () => {} },
    );
  const ask = [{ role: 'user' as const, content: 'hi' }];

  beforeEach(() => {
    groq.keys.length = 0;
    groq.setValidKeys(null);
    groq.setScript(defaultScriptRef);
  });

  it("calls the provider with the workspace's key, never the platform key", async () => {
    const gw = tenantGroq('platform-key');
    const scoped = gw.scoped({ groq: { keyId: 'k1', apiKey: 'tenant-key' } });
    await scoped.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask });
    await gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask });
    expect(groq.keys).toEqual(['tenant-key', 'platform-key']);
  });

  it('serves a provider with no platform key once the workspace has its own', async () => {
    const gw = tenantGroq('');
    expect(gw.listModels().every((m) => !m.available)).toBe(true);
    const scoped = gw.scoped({ groq: { keyId: 'k1', apiKey: 'tenant-key' } });
    expect(scoped.listModels()).toEqual([expect.objectContaining({ ref: 'groq/llama-3.3-70b-versatile', available: true, keySource: 'workspace' })]);
    expect(scoped.defaultModel()).toBe('groq/llama-3.3-70b-versatile');
    const res = await scoped.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask });
    expect(res.text).toContain('NeuroFlow mock answer');
  });

  it('can refuse platform keys: without a workspace key the call fails with a clear message', async () => {
    const gw = tenantGroq('platform-key');
    const scoped = gw.scoped({}, { platformKeys: false });
    expect(scoped.listModels()[0]).toMatchObject({ available: false });
    await expect(scoped.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask })).rejects.toThrow(/No API key for Groq/);
    expect(groq.keys).toEqual([]);
  });

  it('a rate-limited workspace key does not block the platform key or other workspaces', async () => {
    const t = virtualTime();
    const gw = new DefaultModelGateway(
      [new GroqAdapter({ baseUrl: groq.url, apiKey: 'platform-key', models: buildCatalog('llama-3.3-70b-versatile') })],
      { baseBackoffMs: 1, maxBackoffMs: 5, maxRetries: 0, maxRateLimitWaitMs: 1_000 },
      t.opts,
    );
    groq.setScript((body, i) => (i === 0 ? { kind: 'error', status: 429, retryAfter: '30' } : textReply('ok')));
    const a = gw.scoped({ groq: { keyId: 'tenant-a', apiKey: 'key-a' } });
    await expect(a.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask })).rejects.toBeInstanceOf(ModelError);
    // Tenant A's key is now blocked for 30 s; tenant B and the platform key are unaffected.
    const b = gw.scoped({ groq: { keyId: 'tenant-b', apiKey: 'key-b' } });
    await b.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask });
    await gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask });
    expect(groq.keys).toEqual(['key-a', 'key-b', 'platform-key']);
    await expect(a.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask })).rejects.toThrow(/rate limiting this workspace's key/);
    groq.setScript(defaultScriptRef);
  });

  it('verifies a key against the provider before it is stored', async () => {
    groq.setValidKeys(['good-key']);
    const gw = tenantGroq('');
    expect(await gw.verifyCredential('groq', 'good-key')).toEqual({ ok: true });
    expect(await gw.verifyCredential('groq', 'bad-key')).toMatchObject({ ok: false, reason: 'rejected' });
    expect(await gw.verifyCredential('qwen', 'x')).toMatchObject({ ok: false });
    expect(gw.credentialProviders()).toEqual([{ id: 'groq', displayName: 'Groq', platformKey: false }]);
  });

  it('reports which workspace key served a call', async () => {
    const gw = tenantGroq('platform-key');
    const res = await gw.scoped({ groq: { keyId: 'k-7', apiKey: 'tenant-key' } }).complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask });
    expect(res.keyId).toBe('k-7');
    expect((await gw.complete({ model: 'groq/llama-3.3-70b-versatile', messages: ask })).keyId).toBeUndefined();
  });
});

describe('call guard (spending limits)', () => {
  beforeEach(() => {
    groq.keys.length = 0;
  });

  it('a refused model is skipped and the chain falls back, without spending a request on it', async () => {
    const seen: Array<{ provider: string; keyId?: string }> = [];
    const scoped = gateway().scoped(
      { groq: { keyId: 'over-budget', apiKey: 'tenant-key' } },
      {
        guard: async (t) => {
          seen.push({ provider: t.provider, ...(t.keyId ? { keyId: t.keyId } : {}) });
          return t.keyId === 'over-budget' ? new ModelError('spend_limit', 'key budget reached', { retryable: false }) : undefined;
        },
      },
    );
    const events = await collect(scoped.stream({ model: 'groq/llama-3.3-70b-versatile', fallbacks: ['qwen/qwen3:8b'], messages: user }));
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.response.ref).toBe('qwen/qwen3:8b');
    expect(events).toContainEqual(expect.objectContaining({ type: 'fallback', reason: 'key budget reached' }));
    expect(seen).toEqual([{ provider: 'groq', keyId: 'over-budget' }, { provider: 'qwen' }]);
    expect(groq.requests).toHaveLength(0);
  });

  it('when every model is refused the call fails with the guard error', async () => {
    const scoped = gateway().scoped({}, { guard: async () => new ModelError('spend_limit', 'monthly limit reached', { retryable: false }) });
    await expect(scoped.complete({ model: 'qwen/qwen3:8b', fallbacks: ['groq/llama-3.3-70b-versatile'], messages: user })).rejects.toMatchObject({
      code: 'spend_limit',
      message: 'monthly limit reached',
    });
    expect(qwen.requests).toHaveLength(0);
  });
});
