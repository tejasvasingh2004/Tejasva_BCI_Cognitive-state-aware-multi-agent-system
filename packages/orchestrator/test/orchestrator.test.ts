import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultScript,
  startMockOpenAIServer,
  textReply,
  toolCallReply,
  type MockOpenAIServer,
} from '@neuroflow/models/testing';
import { RunCancelledError, StageError, toRunError } from '../src';
import { makeOrchestrator, runInput, streamed, types } from './helpers';

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
  qwen.setScript(defaultScript);
  groq.setScript(defaultScript);
  qwen.requests.length = 0;
  groq.requests.length = 0;
});

describe('Orchestrator', () => {
  it('DIRECT: streams a single model response and returns exactly what was streamed', async () => {
    const { orchestrator, store } = makeOrchestrator({ qwen });
    const { input, events } = runInput('hello');
    const out = await orchestrator.execute(input);
    expect(out.plan.agentStrategy).toBe('direct');
    expect(out.output).toBe('NeuroFlow mock answer to: hello');
    expect(streamed(events)).toBe(out.output);
    expect(types(events)).toEqual(
      expect.arrayContaining(['router.started', 'router.selected', 'context.built', 'model.started', 'model.completed', 'evaluation.completed']),
    );
    expect(qwen.requests[0]!.tools).toBeUndefined();
    expect(store.evaluations[0]).toMatchObject({ kind: 'heuristic', verdict: 'passed' });
  });

  it('an empty model answer fails the run with a clear empty_response error', async () => {
    qwen.setScript(() => textReply(''));
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input } = runInput('hello');
    const err = await orchestrator.execute(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    const stageError = err as StageError;
    expect(toRunError(stageError.cause, stageError.stage)).toMatchObject({ code: 'empty_response', stage: 'evaluation' });
  });

  it('SINGLE_AGENT: model requests a tool, runtime validates and executes it, model resumes', async () => {
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input, events } = runInput('Please calculate 12*(3+4)');
    const out = await orchestrator.execute(input);
    expect(out.plan.agentStrategy).toBe('single_agent');
    const completed = events.find((e) => e.type === 'tool.completed');
    expect(completed?.type === 'tool.completed' && completed.data).toMatchObject({ name: 'calculator', status: 'success' });
    expect(out.output).toContain('84');
    // Second model call received the tool result.
    expect(qwen.requests[1]!.messages.some((m) => m.role === 'tool')).toBe(true);
    const order = types(events).filter((t) => t.startsWith('agent.') || t.startsWith('tool.') || t === 'model.started');
    expect(order).toEqual(['agent.started', 'model.started', 'tool.started', 'tool.completed', 'model.started', 'agent.completed']);
  });

  it('invalid tool arguments are rejected and reported to the model, not executed', async () => {
    qwen.setScript((body, i) =>
      i === 0 ? toolCallReply('calculator', { expr: 'oops' }) : textReply(`saw: ${body.messages.at(-1)!.content}`),
    );
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input, events } = runInput('calculate something', { agentStrategy: 'single_agent' });
    const out = await orchestrator.execute(input);
    const done = events.find((e) => e.type === 'tool.completed');
    expect(done?.type === 'tool.completed' && done.data.errorCode).toBe('invalid_arguments');
    expect(out.output).toContain('invalid_arguments');
  });

  it('bounds tool loops even if the model keeps calling tools', async () => {
    qwen.setScript((body) =>
      body.tools ? toolCallReply('calculator', { expression: '1+1' }, `c${Math.random()}`) : textReply('final answer'),
    );
    const { orchestrator, store } = makeOrchestrator({ qwen });
    const { input, events } = runInput('calculate forever', { agentStrategy: 'single_agent' });
    const out = await orchestrator.execute(input);
    expect(out.output).toBe('final answer');
    expect(events.filter((e) => e.type === 'tool.started').length).toBeLessThanOrEqual(6);
    expect(store.modelCalls.length).toBeLessThanOrEqual(7);
  });

  it('SEQUENTIAL multi-agent with multi-model spreads roles across providers', async () => {
    const { orchestrator, store } = makeOrchestrator({ qwen, groq });
    const { input, events } = runInput('Research the topic', { agentStrategy: 'sequential', modelStrategy: 'multi' });
    const out = await orchestrator.execute(input);
    expect(store.agents.map((a) => a.agentId)).toEqual(['researcher', 'analyst', 'writer']);
    expect(new Set(store.modelCalls.map((c) => c.provider))).toEqual(new Set(['qwen', 'groq']));
    // Only the writer streams to the user.
    expect(streamed(events)).toBe(out.output);
    expect(out.output).toContain('NeuroFlow mock answer');
  });

  it('PARALLEL runs workers concurrently then synthesises', async () => {
    const { orchestrator, store } = makeOrchestrator({ qwen });
    const { input } = runInput('Two things', { agentStrategy: 'parallel', modelStrategy: 'single' });
    await orchestrator.execute(input);
    expect(store.agents.map((a) => a.agentId).sort()).toEqual(['analyst', 'researcher', 'writer']);
    expect(store.agents.every((a) => a.status === 'completed')).toBe(true);
  });

  it('SUPERVISOR decomposes, delegates and synthesises', async () => {
    const { orchestrator, store } = makeOrchestrator({ qwen });
    const { input } = runInput('Plan a launch', { agentStrategy: 'supervisor' });
    const out = await orchestrator.execute(input);
    expect(store.agents.map((a) => a.agentId)).toEqual(['researcher', 'analyst', 'writer']);
    expect(out.output.length).toBeGreaterThan(0);
  });

  it('SUPERVISOR reviews results and can run one follow-up round', async () => {
    const { orchestrator, store } = makeOrchestrator({ qwen });
    const { input } = runInput('Plan a launch (needs follow-up)', { agentStrategy: 'supervisor' });
    await orchestrator.execute(input);
    expect(store.agents.map((a) => a.agentId)).toEqual(['researcher', 'analyst', 'analyst', 'writer']);
  });

  it('EVALUATOR_OPTIMIZER refines when the evaluator asks for it (bounded)', async () => {
    let evals = 0;
    qwen.setScript((body, i) => {
      if (body.response_format) {
        evals++;
        return textReply(JSON.stringify(evals === 1 ? { verdict: 'needs_refinement', score: 0.4, issues: ['too short'] } : { verdict: 'passed', score: 0.9, issues: [] }));
      }
      return textReply(i === 0 ? 'draft' : 'improved answer');
    });
    const { orchestrator, store } = makeOrchestrator({ qwen });
    const { input, events } = runInput('Explain carefully', { agentStrategy: 'evaluator_optimizer' });
    const out = await orchestrator.execute(input);
    expect(out.output).toBe('improved answer');
    expect(types(events)).toContain('response.reset');
    expect(store.evaluations.map((e) => e.verdict)).toEqual(['needs_refinement', 'passed']);
  });

  it('falls back to another provider when the primary fails', async () => {
    qwen.setScript(() => ({ kind: 'error', status: 503 }));
    groq.setScript(() => textReply('groq saved the day'));
    const { orchestrator } = makeOrchestrator({ qwen, groq });
    const { input, events } = runInput('hello');
    const out = await orchestrator.execute(input);
    expect(out.output).toBe('groq saved the day');
    expect(types(events)).toContain('model.retry');
    expect(types(events)).toContain('model.fallback');
  });

  it('fails with a stage and partial output when all providers fail', async () => {
    qwen.setScript(() => ({ kind: 'error', status: 401 }));
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input } = runInput('hello');
    const err = await orchestrator.execute(input).catch((e) => e);
    expect(err).toBeInstanceOf(StageError);
  });

  it('cancellation aborts the active model stream', async () => {
    qwen.setScript(() => textReply('x'.repeat(400), { chunkSize: 2, chunkDelayMs: 10 }));
    const { orchestrator } = makeOrchestrator({ qwen });
    const ac = new AbortController();
    const { input, events } = runInput('hello', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const err = await orchestrator.execute(input).catch((e) => e);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).cause).toBeInstanceOf(RunCancelledError);
    expect(streamed(events).length).toBeLessThan(400);
  });

  it('COGNITIVE mode applies policy but never blocks when state is unavailable', async () => {
    const high = {
      id: 'test',
      getState: async () => ({ workload: 'high' as const, confidence: 0.9, source: 'bci' as const, observedAt: new Date().toISOString() }),
    };
    const { orchestrator } = makeOrchestrator({ qwen, cognitive: high });
    const { input, events } = runInput('Explain transformers', { mode: 'cognitive' }, { mode: 'cognitive' });
    const out = await orchestrator.execute(input);
    expect(out.plan.cognitive?.workload).toBe('high');
    const system = qwen.requests.at(-2)?.messages[0]?.content ?? qwen.requests[0]!.messages[0]!.content;
    expect(system).toContain('high cognitive load');
    expect(events.find((e) => e.type === 'cognitive.applied')).toMatchObject({ data: { available: true } });

    const broken = { id: 'broken', getState: async () => Promise.reject(new Error('headset offline')) };
    const second = makeOrchestrator({ qwen, cognitive: broken });
    const run2 = runInput('Explain transformers', { mode: 'cognitive' }, { mode: 'cognitive' });
    const out2 = await second.orchestrator.execute(run2.input);
    expect(out2.output.length).toBeGreaterThan(0);
    expect(run2.events.find((e) => e.type === 'cognitive.applied')).toMatchObject({ data: { available: false } });
  });

  it('STANDARD mode never consults the cognitive provider', async () => {
    let called = false;
    const spy = { id: 'spy', getState: async () => ((called = true), null) };
    const { orchestrator } = makeOrchestrator({ qwen, cognitive: spy });
    await orchestrator.execute(runInput('hello').input);
    expect(called).toBe(false);
  });
});
