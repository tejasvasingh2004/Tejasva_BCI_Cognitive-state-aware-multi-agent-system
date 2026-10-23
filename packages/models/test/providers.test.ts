import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AnthropicAdapter,
  DefaultModelGateway,
  ModelError,
  buildCatalog,
  createGatewayFromEnv,
  createGoogleAdapter,
  createOpenAIAdapter,
  createOpenRouterAdapter,
  createTogetherAdapter,
  type ModelMessage,
} from '../src';
import { toAnthropicMessages } from '../src/adapters/anthropic';
import {
  defaultAnthropicScript,
  defaultScript,
  startMockAnthropicServer,
  startMockOpenAIServer,
  type MockAnthropicServer,
  type MockOpenAIServer,
} from '../src/testing';

let claude: MockAnthropicServer;
let openai: MockOpenAIServer;

beforeAll(async () => {
  claude = await startMockAnthropicServer();
  openai = await startMockOpenAIServer();
});
afterAll(async () => {
  await claude.close();
  await openai.close();
});
beforeEach(() => {
  claude.requests.length = 0;
  claude.keys.length = 0;
  claude.setValidKeys(null);
  claude.setScript(defaultAnthropicScript);
  openai.requests.length = 0;
  openai.setScript(defaultScript);
});

const policy = { baseBackoffMs: 1, maxBackoffMs: 5, maxRetries: 1 };
const anthropic = (apiKey = 'platform-key') =>
  new DefaultModelGateway(
    [new AnthropicAdapter({ baseUrl: claude.url, apiKey, models: buildCatalog('claude-sonnet-5-5,claude-haiku-5-5') })],
    policy,
    { sleep: async () => {} },
  );
const ask: ModelMessage[] = [
  { role: 'system', content: 'You are NeuroFlow.' },
  { role: 'user', content: 'hi' },
];
const tools = [{ name: 'calculator', description: 'Math', inputSchema: { type: 'object', properties: { expr: { type: 'string' } } } }];

describe('Anthropic adapter', () => {
  it('streams text with usage and cost, sending Claude-native parameters only', async () => {
    const res = await anthropic().complete({ model: 'anthropic/claude-sonnet-5-5', messages: ask, temperature: 0.2, reasoningBudget: 'high' });
    expect(res.text).toBe('Hello from mock Claude.');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toMatchObject({ promptTokens: 12, completionTokens: 11, totalTokens: 23 });
    expect(res.usage?.costUsd).toBeGreaterThan(0);
    expect(res.providerState).toBeUndefined();
    const body = claude.requests[0]!;
    expect(body.system).toBe('You are NeuroFlow.');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('temperature');
    expect(claude.keys[0]).toBe('platform-key');
  });

  it('maps reasoning off to low effort, required tool choice to auto and JSON mode to an instruction', async () => {
    await anthropic().complete({ model: 'anthropic/claude-haiku-5-5', messages: ask, responseFormat: 'json', tools, toolChoice: 'required' });
    const body = claude.requests[0]!;
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.tools).toEqual([expect.objectContaining({ name: 'calculator', input_schema: expect.objectContaining({ type: 'object' }) })]);
    expect(body.system).toContain('single JSON object');
  });

  it('returns tool calls with provider state and replays thinking blocks unchanged in the tool loop', async () => {
    claude.setScript((body, i) =>
      i === 0
        ? {
            kind: 'message',
            blocks: [
              { type: 'thinking', signature: 'sig-A' },
              { type: 'text', text: 'Let me compute.' },
              { type: 'tool_use', id: 'toolu_1', name: 'calculator', input: { expr: '2+2' } },
            ],
          }
        : defaultAnthropicScript(body, i),
    );
    const gw = anthropic();
    const first = await gw.complete({ model: 'anthropic/claude-sonnet-5-5', messages: ask, tools });
    expect(first.finishReason).toBe('tool_calls');
    expect(first.toolCalls).toEqual([{ id: 'toolu_1', name: 'calculator', arguments: '{"expr":"2+2"}' }]);
    expect(first.providerState).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });

    const second = await gw.complete({
      model: 'anthropic/claude-sonnet-5-5',
      tools,
      messages: [
        ...ask,
        { role: 'assistant', content: first.text, toolCalls: first.toolCalls, providerState: first.providerState },
        { role: 'tool', content: '{"result":4}', toolCallId: 'toolu_1', name: 'calculator' },
      ],
    });
    expect(second.text).toBe('Claude used the tool result.');
    const replay = claude.requests[1]!.messages;
    expect(replay[1]).toEqual({
      role: 'assistant',
      content: [
        expect.objectContaining({ type: 'thinking', signature: 'sig-A' }),
        expect.objectContaining({ type: 'text', text: 'Let me compute.' }),
        expect.objectContaining({ type: 'tool_use', id: 'toolu_1', input: { expr: '2+2' } }),
      ],
    });
    expect(replay[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"result":4}' }] });
  });

  it('retries once without thinking blocks when the API reports they belong to a different conversation', async () => {
    claude.setScript((body, i) =>
      i === 0
        ? { kind: 'error', status: 400, message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' }
        : defaultAnthropicScript(body, i),
    );
    const providerState = {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-old' },
        { type: 'tool_use', id: 't1', name: 'calculator', input: {} },
      ],
    };
    const res = await anthropic().complete({
      model: 'anthropic/claude-sonnet-5-5',
      messages: [
        ...ask,
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'calculator', arguments: '{}' }], providerState },
        { role: 'tool', content: 'ok', toolCallId: 't1' },
      ],
    });
    expect(res.text).toBe('Claude used the tool result.');
    expect(claude.requests).toHaveLength(2);
    expect(claude.requests[1]!.messages[1]!.content).toEqual([expect.objectContaining({ type: 'tool_use', id: 't1' })]);
  });

  it('maps provider errors: rejected keys are not retried, rate limits honour retry-after', async () => {
    claude.setValidKeys(['good']);
    const auth = await anthropic('bad')
      .complete({ model: 'anthropic/claude-sonnet-5-5', messages: ask })
      .catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(ModelError);
    expect((auth as ModelError).code).toBe('auth');
    expect(claude.requests).toHaveLength(0);

    claude.setValidKeys(null);
    claude.setScript((body, i) => (i === 0 ? { kind: 'error', status: 429, message: 'rate limited', retryAfter: '1' } : defaultAnthropicScript(body, i)));
    const events: string[] = [];
    for await (const ev of anthropic().stream({ model: 'anthropic/claude-sonnet-5-5', messages: ask })) events.push(ev.type);
    expect(events).toContain('retry');
    expect(events.at(-1)).toBe('done');
  });

  it('serves workspace keys (BYOK) and verifies them with the provider', async () => {
    claude.setValidKeys(['tenant-key']);
    const gw = anthropic('');
    expect(gw.listModels().every((m) => !m.available)).toBe(true);
    expect(await gw.verifyCredential('anthropic', 'tenant-key')).toEqual({ ok: true });
    expect(await gw.verifyCredential('anthropic', 'wrong')).toMatchObject({ ok: false, reason: 'rejected' });
    const scoped = gw.scoped({ anthropic: { keyId: 'k1', apiKey: 'tenant-key' } });
    const res = await scoped.complete({ model: 'anthropic/claude-haiku-5-5', messages: ask });
    expect(res.text).toBe('Hello from mock Claude.');
    expect(claude.keys).toEqual(['tenant-key']);
  });

  it('builds turns: system collected, tool results merged into one user turn, foreign provider state ignored', () => {
    const { system, messages } = toAnthropicMessages(
      [
        { role: 'system', content: 'A' },
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'a', name: 'x', arguments: '{"n":1}' },
            { id: 'b', name: 'y', arguments: 'not json' },
          ],
          providerState: { provider: 'anthropic', model: 'other-model', content: [] },
        },
        { role: 'tool', content: '1', toolCallId: 'a' },
        { role: 'tool', content: '', toolCallId: 'b' },
        { role: 'system', content: 'B' },
      ],
      'claude-sonnet-5-5',
    );
    expect(system).toEqual(['A', 'B']);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'x', input: { n: 1 } },
          { type: 'tool_use', id: 'b', name: 'y', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: '1' },
          { type: 'tool_result', tool_use_id: 'b', content: '(empty)' },
        ],
      },
    ]);
  });
});

describe('OpenAI and Google adapters', () => {
  it('OpenAI: max_completion_tokens, no temperature, reasoning effort', async () => {
    const gw = new DefaultModelGateway([createOpenAIAdapter({ baseUrl: openai.url, apiKey: 'k', models: buildCatalog('gpt-6.1-sol') })], policy, {
      sleep: async () => {},
    });
    const res = await gw.complete({ model: 'openai/gpt-6.1-sol', messages: ask, temperature: 0.3, maxOutputTokens: 500, reasoningBudget: 'medium' });
    expect(res.text.length).toBeGreaterThan(0);
    const body = openai.requests[0]!;
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', max_completion_tokens: 500, reasoning_effort: 'medium' });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('Google: minimal reasoning when off, keeps temperature and max_tokens', async () => {
    const gw = new DefaultModelGateway([createGoogleAdapter({ baseUrl: openai.url, apiKey: 'k', models: buildCatalog('gemini-3.8-flash') })], policy, {
      sleep: async () => {},
    });
    await gw.complete({ model: 'google/gemini-3.8-flash', messages: ask, temperature: 0.3, maxOutputTokens: 200 });
    expect(openai.requests[0]).toMatchObject({ model: 'gemini-3.8-flash', reasoning_effort: 'minimal', temperature: 0.3, max_tokens: 200 });
  });

  it('open-model hosts: GPT-OSS gets reasoning_effort on Together; OpenRouter uses its unified reasoning field and checks keys', async () => {
    const together = new DefaultModelGateway([createTogetherAdapter({ baseUrl: openai.url, apiKey: 'k', models: buildCatalog('openai/gpt-oss-120b,deepseek-ai/DeepSeek-V4.1-Flash') })], policy, {
      sleep: async () => {},
    });
    await together.complete({ model: 'together/openai/gpt-oss-120b', messages: ask, reasoningBudget: 'high' });
    expect(openai.requests[0]).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'high' });
    await together.complete({ model: 'together/deepseek-ai/DeepSeek-V4.1-Flash', messages: ask });
    expect(openai.requests[1]).not.toHaveProperty('reasoning_effort');

    const router = new DefaultModelGateway([createOpenRouterAdapter({ baseUrl: openai.url, apiKey: '', models: buildCatalog('openai/gpt-oss-120b') })], policy, {
      sleep: async () => {},
    });
    openai.setValidKeys(['sk-or-good']);
    try {
      expect(await router.verifyCredential('openrouter', 'sk-or-good')).toEqual({ ok: true });
      expect(await router.verifyCredential('openrouter', 'sk-or-bad')).toMatchObject({ ok: false, reason: 'rejected' });
      await router.scoped({ openrouter: { keyId: 'k', apiKey: 'sk-or-good' } }).complete({ model: 'openrouter/openai/gpt-oss-120b', messages: ask });
      expect(openai.requests[2]).toMatchObject({ reasoning: { effort: 'low', exclude: true } });
      expect(openai.requests[2]).not.toHaveProperty('reasoning_effort');
    } finally {
      openai.setValidKeys(null);
    }
  });

  it('the env factory registers every hosted provider for workspace keys, platform-served only with a key', () => {
    const gw = createGatewayFromEnv({ ANTHROPIC_API_KEY: 'a', QWEN_MODELS: '' });
    const providers = gw.credentialProviders().map((p) => [p.id, p.platformKey]);
    expect(providers).toEqual(
      expect.arrayContaining([
        ['anthropic', true],
        ['openai', false],
        ['google', false],
        ['together', false],
        ['fireworks', false],
        ['openrouter', false],
        ['groq', false],
      ]),
    );
    const models = gw.listModels();
    expect(models.find((m) => m.ref === 'anthropic/claude-sonnet-5-5')?.available).toBe(true);
    expect(models.some((m) => m.provider === 'openai')).toBe(false);
    // With a workspace key the provider's models appear.
    const scoped = gw.scoped({ openai: { keyId: 'k', apiKey: 'sk' } });
    expect(scoped.listModels().find((m) => m.ref === 'openai/gpt-6.1-sol')).toMatchObject({ available: true, keySource: 'workspace' });
  });
});
