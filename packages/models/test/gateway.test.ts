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
import { startMockOpenAIServer, textReply, type MockOpenAIServer } from '../src/testing';

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
    expect(gw.listModels()[0]!.available).toBe(false);
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
});
