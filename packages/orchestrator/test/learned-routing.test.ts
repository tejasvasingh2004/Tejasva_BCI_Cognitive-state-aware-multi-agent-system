import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@neuroflow/contracts';
import { derivePolicy } from '@neuroflow/cognitive';
import { planExecution, type LearnedRouting } from '../src';

const model = (ref: string, tier: ModelInfo['tier']): ModelInfo => ({
  ref,
  provider: ref.split('/')[0]!,
  model: ref.split('/').slice(1).join('/'),
  displayName: ref,
  tier,
  contextWindow: 131_072,
  capabilities: { tools: true, reasoning: false, streaming: true },
  available: true,
});
const models = [model('groq/openai/gpt-oss-120b', 'strong'), model('groq/openai/gpt-oss-20b', 'balanced'), model('groq/llama-3.1-8b-instant', 'fast'), model('qwen/qwen3:8b', 'balanced')];
const base = {
  mode: 'standard' as const,
  request: { agentStrategy: 'auto' as const, modelStrategy: 'single' as const },
  models,
  defaultModel: 'groq/openai/gpt-oss-120b',
  availableTools: [],
};
// A question the classifier puts in the "analysis" class.
const ask = 'Compare Postgres and MongoDB for our use case';
const never = () => 0.99;
const primaryOf = (learned?: LearnedRouting, extra: Partial<typeof base> & Record<string, unknown> = {}) => {
  const plan = planExecution({ ...base, ...extra, lastUserMessage: ask, ...(learned ? { learned } : {}) } as Parameters<typeof planExecution>[0]);
  return { primary: plan.models[0]!.model, plan };
};

describe('learned routing', () => {
  it('routes to the cheapest model that keeps the best measured quality', () => {
    const learned: LearnedRouting = {
      random: never,
      byTask: {
        analysis: [
          { ref: 'groq/openai/gpt-oss-120b', samples: 80, quality: 0.91, costUsd: 0.004, latencyMs: 2100 },
          { ref: 'groq/openai/gpt-oss-20b', samples: 60, quality: 0.88, costUsd: 0.0012, latencyMs: 900 },
          { ref: 'groq/llama-3.1-8b-instant', samples: 50, quality: 0.62, costUsd: 0.0002, latencyMs: 500 },
        ],
      },
    };
    const { primary, plan } = primaryOf(learned);
    expect(primary).toBe('groq/openai/gpt-oss-20b');
    expect(plan.rationale.join(' ')).toMatch(/matches the best measured quality for analysis tasks \(0\.88 vs 0\.91\) at lower cost/);
  });

  it('keeps the strong model when the cheaper one is clearly worse, and ignores thin or unavailable data', () => {
    const learned: LearnedRouting = {
      random: never,
      byTask: {
        analysis: [
          { ref: 'groq/openai/gpt-oss-120b', samples: 80, quality: 0.91, costUsd: 0.004 },
          { ref: 'groq/openai/gpt-oss-20b', samples: 60, quality: 0.8, costUsd: 0.0012 },
          // Too few runs to trust, and a model this workspace cannot use.
          { ref: 'groq/llama-3.1-8b-instant', samples: 5, quality: 1, costUsd: 0.0001 },
          { ref: 'together/deepseek-ai/DeepSeek-V4.1-Flash', samples: 500, quality: 0.99, costUsd: 0.0001 },
        ],
      },
    };
    expect(primaryOf(learned).primary).toBe('groq/openai/gpt-oss-120b');
  });

  it('never overrides an explicit model, a cognitive preference or other task classes', () => {
    const learned: LearnedRouting = {
      random: never,
      byTask: { analysis: [{ ref: 'groq/openai/gpt-oss-20b', samples: 60, quality: 0.95, costUsd: 0.001 }] },
    };
    expect(primaryOf(learned, { request: { ...base.request, selectedModel: 'qwen/qwen3:8b' } } as never).primary).toBe('qwen/qwen3:8b');
    // High workload prefers the fastest model; that preference wins over measured outcomes.
    const cognitive = derivePolicy({ workload: 'high', source: 'self_report', confidence: 1, updatedAt: new Date().toISOString() } as never);
    expect(cognitive.modelPreference).toBe('fast');
    expect(primaryOf(learned, { cognitive } as never).primary).toBe('groq/llama-3.1-8b-instant');
    // No outcomes for this task class: the configured default.
    const other = planExecution({ ...base, lastUserMessage: 'hi!', learned } as Parameters<typeof planExecution>[0]);
    expect(other.models[0]!.model).toBe('groq/openai/gpt-oss-120b');
  });

  it('explores an under-sampled model of comparable strength now and then', () => {
    const outcomes = { analysis: [{ ref: 'groq/openai/gpt-oss-120b', samples: 80, quality: 0.91, costUsd: 0.004 }] };
    const { primary, plan } = primaryOf({ byTask: outcomes, random: () => 0, exploration: 0.05 });
    // Comparable = within one tier of the anchor (strong): the balanced models, least-sampled first.
    expect(['groq/openai/gpt-oss-20b', 'qwen/qwen3:8b']).toContain(primary);
    expect(plan.rationale.join(' ')).toMatch(/exploring/);
    expect(primaryOf({ byTask: outcomes, random: () => 0, exploration: 0 }).primary).toBe('groq/openai/gpt-oss-120b');
    expect(primaryOf({ byTask: outcomes, random: never, exploration: 0.05 }).primary).toBe('groq/openai/gpt-oss-120b');
  });
});

describe('learned routing in the orchestrator', () => {
  it('uses the measured outcomes the host provides when planning a run', async () => {
    const { startMockOpenAIServer } = await import('@neuroflow/models/testing');
    const { Orchestrator } = await import('../src');
    const { ToolRegistry, ToolRuntime } = await import('@neuroflow/tools');
    const { makeGateway, MemoryStore, runInput } = await import('./helpers');
    const qwen = await startMockOpenAIServer();
    const groq = await startMockOpenAIServer();
    try {
      const orchestrator = new Orchestrator({
        gateway: makeGateway(qwen, groq),
        tools: new ToolRuntime(new ToolRegistry()),
        store: new MemoryStore(),
        learnedRouting: async () => ({
          random: never,
          byTask: { analysis: [{ ref: 'groq/llama-3.3-70b-versatile', samples: 40, quality: 0.95, costUsd: 0.001 }] },
        }),
      });
      const { input, events } = runInput(ask, { agentStrategy: 'direct' });
      await orchestrator.execute(input);
      const plan = events.find((e) => e.type === 'router.selected');
      expect(plan?.type === 'router.selected' && plan.data.plan.models[0]?.model).toBe('groq/llama-3.3-70b-versatile');
      expect(plan?.type === 'router.selected' && plan.data.plan.rationale.join(' ')).toMatch(/Learned routing/);
      expect(groq.requests.length).toBeGreaterThan(0);
    } finally {
      await qwen.close();
      await groq.close();
    }
  });
});
