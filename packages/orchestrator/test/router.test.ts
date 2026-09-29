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
});
