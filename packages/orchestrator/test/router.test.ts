import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@neuroflow/contracts';
import { derivePolicy } from '@neuroflow/cognitive';
import { buildContext, classifyTask, planExecution, RoutingError } from '../src';

const model = (ref: string, tier: ModelInfo['tier'], available = true): ModelInfo => ({
  ref,
  provider: ref.split('/')[0]!,
  model: ref.split('/').slice(1).join('/'),
  displayName: ref,
  tier,
  contextWindow: 32_768,
  capabilities: { tools: true, reasoning: false, streaming: true },
  available,
});
const models = [model('qwen/qwen3:8b', 'balanced'), model('groq/llama-3.3-70b-versatile', 'strong'), model('groq/llama-3.1-8b-instant', 'fast')];
const base = {
  mode: 'standard' as const,
  request: { agentStrategy: 'auto' as const, modelStrategy: 'auto' as const },
  models,
  defaultModel: 'qwen/qwen3:8b',
  availableTools: ['calculator', 'search_memory'],
};

describe('classifyTask', () => {
  it('classifies common task shapes', () => {
    expect(classifyTask('hi!').taskClass).toBe('conversational');
    expect(classifyTask('What did I decide about pricing?').taskClass).toBe('memory');
    expect(classifyTask('calculate 17 * 23').taskClass).toBe('tool');
    expect(classifyTask('Compare Postgres and MongoDB for our use case').taskClass).toBe('analysis');
    const complex = classifyTask(
      'Give me a comprehensive, in-depth architecture review:\n1. security\n2. scalability\n3. cost\n4. observability',
    );
    expect(complex.taskClass).toBe('complex');
    expect(complex.independentParts).toBeGreaterThanOrEqual(3);
  });
});

describe('planExecution', () => {
  it('uses the smallest reliable graph', () => {
    expect(planExecution({ ...base, lastUserMessage: 'hello' }).agentStrategy).toBe('direct');
    expect(planExecution({ ...base, lastUserMessage: 'What did I decide about pricing?' }).agentStrategy).toBe('single_agent');
    expect(planExecution({ ...base, lastUserMessage: 'Explain what a BCI is' }).agentStrategy).toBe('single_agent');
    const plan = planExecution({
      ...base,
      lastUserMessage: 'Give me a comprehensive, in-depth plan:\n1. hiring\n2. pricing\n3. launch\n4. risks',
    });
    expect(plan.agentStrategy).toBe('supervisor');
  });

  it('keeps agent and model topology independent', () => {
    const multiAgentSingleModel = planExecution({
      ...base,
      request: { agentStrategy: 'sequential', modelStrategy: 'single' },
      lastUserMessage: 'x',
    });
    expect(new Set(multiAgentSingleModel.models.map((m) => m.model)).size).toBe(1);

    const multiAgentMultiModel = planExecution({
      ...base,
      request: { agentStrategy: 'sequential', modelStrategy: 'multi' },
      lastUserMessage: 'x',
    });
    expect(new Set(multiAgentMultiModel.models.map((m) => m.model)).size).toBeGreaterThan(1);
    // The strongest model synthesises; assignment is by tier, not by provider.
    expect(multiAgentMultiModel.models.find((m) => m.role === 'synthesis')!.model).toBe('groq/llama-3.3-70b-versatile');

    const singleAgentMultiModel = planExecution({
      ...base,
      request: { agentStrategy: 'evaluator_optimizer', modelStrategy: 'multi' },
      lastUserMessage: 'x',
    });
    expect(singleAgentMultiModel.agents).toContain('assistant');
    expect(new Set(singleAgentMultiModel.models.map((m) => m.model)).size).toBeGreaterThan(1);

    const single = planExecution({ ...base, request: { agentStrategy: 'single_agent', modelStrategy: 'single' }, lastUserMessage: 'x' });
    expect(single.models).toHaveLength(1);
  });

  it('respects the selected model and gives cross-provider fallbacks', () => {
    const plan = planExecution({
      ...base,
      request: { agentStrategy: 'auto', modelStrategy: 'auto', selectedModel: 'groq/llama-3.1-8b-instant' },
      lastUserMessage: 'Explain transformers',
    });
    expect(plan.models[0]!.model).toBe('groq/llama-3.1-8b-instant');
    expect(plan.models[0]!.fallbacks[0]).toBe('qwen/qwen3:8b');
  });

  it('orders fallbacks by capability before provider: no silent downgrade to a much weaker model', () => {
    const plan = planExecution({
      ...base,
      models: [
        model('groq/openai/gpt-oss-120b', 'strong'),
        model('qwen/qwen3:0.6b', 'fast'),
        model('groq/openai/gpt-oss-20b', 'balanced'),
        model('groq/qwen/qwen3.8-27b', 'balanced'),
      ],
      request: { agentStrategy: 'single_agent', modelStrategy: 'single', selectedModel: 'groq/openai/gpt-oss-120b' },
      lastUserMessage: 'Fix the failing test',
    });
    expect(plan.models[0]!.fallbacks).toEqual(['groq/openai/gpt-oss-20b', 'groq/qwen/qwen3.8-27b']);
  });

  it('fails clearly without usable models', () => {
    expect(() => planExecution({ ...base, models: [model('qwen/x', 'fast', false)], lastUserMessage: 'hi' })).toThrow(RoutingError);
    expect(() =>
      planExecution({ ...base, request: { ...base.request, selectedModel: 'groq/nope' }, lastUserMessage: 'hi' }),
    ).toThrow(RoutingError);
  });

  it('applies cognitive policy as a bounded cap on automatic strategies only', () => {
    const cognitive = derivePolicy({ workload: 'high', confidence: 0.9, source: 'bci', observedAt: new Date().toISOString() });
    const text = 'Give me a comprehensive, in-depth plan:\n1. hiring\n2. pricing\n3. launch\n4. risks';
    const capped = planExecution({ ...base, mode: 'cognitive', cognitive, lastUserMessage: text });
    expect(capped.agentStrategy).toBe('single_agent');
    expect(capped.contextPolicy.recentMessages).toBe(8);
    expect(capped.evaluationPolicy.kind).toBe('model');
    const explicit = planExecution({
      ...base,
      mode: 'cognitive',
      cognitive,
      request: { agentStrategy: 'supervisor', modelStrategy: 'auto' },
      lastUserMessage: text,
    });
    expect(explicit.agentStrategy).toBe('supervisor');
    // Tool policy is unaffected by cognitive state.
    expect(capped.toolPolicy.allowed).toEqual(base.availableTools);
  });

  it('restricts tools to the request allow-list', () => {
    const plan = planExecution({ ...base, request: { ...base.request, tools: ['calculator'] }, lastUserMessage: 'calculate 2+2' });
    expect(plan.toolPolicy.allowed).toEqual(['calculator']);
  });
});

describe('buildContext', () => {
  it('bounds history and always keeps system + current task', () => {
    const plan = planExecution({ ...base, lastUserMessage: 'x' });
    plan.contextPolicy.maxInputTokens = 300;
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `message ${i} ${'lorem '.repeat(20)}`,
    }));
    history.push({ role: 'user', content: 'the current question' });
    const { messages, report } = buildContext({ plan, history });
    expect(messages[0]!.role).toBe('system');
    expect(messages.at(-1)!.content).toBe('the current question');
    expect(messages.length).toBeLessThan(10);
    expect(report.droppedMessages).toBeGreaterThan(40);
  });

  it('keeps a long tool loop within budget: tool schemas are reserved, older results compacted', () => {
    const plan = planExecution({ ...base, lastUserMessage: 'x' });
    plan.contextPolicy.maxInputTokens = 4_000;
    const scratch = Array.from({ length: 4 }, (_, i) => [
      { role: 'assistant' as const, content: '', toolCalls: [{ id: `t${i}`, name: 'read_file', arguments: '{}' }] },
      { role: 'tool' as const, content: `result ${i} ${'x'.repeat(3_000)}`, toolCallId: `t${i}`, name: 'read_file' },
    ]).flat();
    const { messages, report } = buildContext({ plan, history: [{ role: 'user', content: 'fix it' }], scratch, reserveTokens: 1_000 });
    const tools = messages.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(4);
    // Pairing is intact; the two most recent results stay verbatim, older ones are stubs.
    expect(tools.slice(-2).every((m) => m.content.startsWith('result'))).toBe(true);
    expect(tools[0]!.content).toMatch(/omitted to stay within the context budget/);
    expect(report.compactedToolResults).toBeGreaterThanOrEqual(1);
    expect(report.totalTokens).toBeLessThanOrEqual(3_000);
  });

  it('flattens earlier tool exchanges so a window never starts with an orphaned tool result', () => {
    const plan = planExecution({ ...base, lastUserMessage: 'x' });
    const { messages } = buildContext({
      plan,
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'lookup', arguments: '{}' }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 't', name: 'lookup' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'assistant', 'user']);
    expect(messages.some((m) => m.toolCalls)).toBe(false);
    expect(messages[2]!.content).toContain('[called tools: lookup({})]');
  });
});

describe('planExecution budgets and preferences', () => {
  const priced: ModelInfo[] = [
    { ...model('qwen/qwen3:8b', 'balanced'), pricing: { inputPerMTok: 0, outputPerMTok: 0 } },
    { ...model('groq/llama-3.3-70b-versatile', 'strong'), pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79 } },
    model('groq/unpriced', 'fast'),
  ];

  it('caps automatic strategies under a tight latency budget and prefers the fastest model', () => {
    const plan = planExecution({
      ...base,
      request: { ...base.request, budget: { maxDurationMs: 20_000 } },
      lastUserMessage: 'Give a comprehensive, in-depth analysis comparing A and B: 1. cost 2. risk 3. speed',
    });
    expect(['direct', 'single_agent']).toContain(plan.agentStrategy);
    expect(plan.budgets.maxDurationMs).toBe(20_000);
    expect(plan.models[0]!.model).toBe('groq/llama-3.1-8b-instant');
  });

  it('restricts to priced models under a cost budget and records it', () => {
    const plan = planExecution({
      ...base,
      models: priced,
      request: { ...base.request, budget: { maxCostUsd: 0.01 } },
      lastUserMessage: 'hi',
    });
    expect(plan.budgets.maxCostUsd).toBe(0.01);
    expect(plan.models.every((m) => m.model !== 'groq/unpriced')).toBe(true);
    expect(plan.models[0]!.model).toBe('qwen/qwen3:8b');
  });

  it('applies the cognitive model preference to automatic model selection', () => {
    const high = derivePolicy({ workload: 'high', confidence: 1, source: 'manual', observedAt: '' });
    expect(planExecution({ ...base, cognitive: high, lastUserMessage: 'what is dns?' }).models[0]!.model).toBe(
      'groq/llama-3.1-8b-instant',
    );
    const low = derivePolicy({ workload: 'low', confidence: 1, source: 'manual', observedAt: '' });
    expect(planExecution({ ...base, cognitive: low, lastUserMessage: 'what is dns?' }).models[0]!.model).toBe(
      'groq/llama-3.3-70b-versatile',
    );
  });

  it('routes client tools to a direct call and named agents to a single agent', () => {
    const client = planExecution({
      ...base,
      request: { ...base.request, clientTools: [{ name: 't', description: '', parameters: {} }] },
      lastUserMessage: 'analyse in depth',
    });
    expect(client.agentStrategy).toBe('direct');
    expect(client.toolPolicy.allowed).toEqual([]);
    const named = planExecution({
      ...base,
      availableAgents: ['assistant', 'reviewer'],
      request: { ...base.request, agent: 'reviewer' },
      lastUserMessage: 'hi',
    });
    expect(named).toMatchObject({ agentStrategy: 'single_agent', agents: ['reviewer'] });
    expect(() =>
      planExecution({ ...base, availableAgents: ['assistant'], request: { ...base.request, agent: 'ghost' }, lastUserMessage: 'hi' }),
    ).toThrow(RoutingError);
  });
});
