import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultScript, startMockOpenAIServer, textReply, toolCallReply, type MockOpenAIServer } from '@neuroflow/models/testing';
import { agentFromSpec, BudgetExceededError, selectForSummary, StageError, summarizeConversation, SUMMARY_POLICY } from '../src';
import { makeGateway, makeOrchestrator, runInput, types } from './helpers';

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

const evaluation = (events: ReturnType<typeof runInput>['events']) => {
  const e = events.find((x) => x.type === 'evaluation.completed');
  return e?.type === 'evaluation.completed' ? e.data : undefined;
};

describe('budgets', () => {
  it('enforces the wall-clock budget by interrupting an in-flight model call', async () => {
    qwen.setScript(() => textReply('a slow answer that streams for a long time', { chunkSize: 2, chunkDelayMs: 50 }));
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input } = runInput('hello', { budget: { maxDurationMs: 300 } });
    const started = Date.now();
    const err = await orchestrator.execute(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).cause).toBeInstanceOf(BudgetExceededError);
    expect(((err as StageError).cause as BudgetExceededError).budget).toBe('time');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('enforces a cost budget with priced models', async () => {
    groq.setScript((body) =>
      body.tools ? toolCallReply('calculator', { expression: '1+1' }, `c${Math.random()}`) : textReply('done'),
    );
    const { orchestrator } = makeOrchestrator({ qwen, groq });
    const { input } = runInput('calculate 1+1', {
      agentStrategy: 'single_agent',
      selectedModel: 'groq/llama-3.3-70b-versatile',
      budget: { maxCostUsd: 0.000_000_1 },
    });
    const err = (await orchestrator.execute(input).catch((e: unknown) => e)) as StageError;
    expect((err.cause as BudgetExceededError).budget).toBe('cost');
  });

  it('reports cost in usage for priced models', async () => {
    const { orchestrator } = makeOrchestrator({ qwen, groq });
    const out = await orchestrator.execute(runInput('hello', { selectedModel: 'groq/llama-3.3-70b-versatile' }).input);
    expect(out.usage?.costUsd).toBeGreaterThan(0);
    const local = await orchestrator.execute(runInput('hello').input);
    expect(local.usage?.costUsd).toBe(0);
  });
});

describe('evaluation', () => {
  it('validates structured output against the requested JSON Schema', async () => {
    const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } };
    qwen.setScript(() => textReply('{"answer":"forty-two"}'));
    const { orchestrator } = makeOrchestrator({ qwen });
    const bad = runInput('give json', { responseFormat: { type: 'json_schema', schema } });
    await orchestrator.execute(bad.input);
    expect(evaluation(bad.events)?.verdict).toBe('needs_refinement');
    expect(evaluation(bad.events)?.issues.join(' ')).toContain('does not match the requested schema');
    // The provider was asked for JSON and told the schema.
    expect(qwen.requests[0]!.response_format).toBeDefined();
    expect(qwen.requests[0]!.messages[0]!.content).toContain('"required":["answer"]');

    qwen.setScript(() => textReply('{"answer": 42}'));
    const good = runInput('give json', { responseFormat: { type: 'json_schema', schema } });
    await orchestrator.execute(good.input);
    expect(evaluation(good.events)?.verdict).toBe('passed');

    qwen.setScript(() => textReply('not json at all'));
    const notJson = runInput('give json', { responseFormat: 'json' });
    await orchestrator.execute(notJson.input);
    expect(evaluation(notJson.events)?.issues.join(' ')).toContain('not valid JSON');
  });

  it('flags loops (repeated identical tool calls) and the tool-call limit in the trajectory', async () => {
    qwen.setScript((body) =>
      body.tools ? toolCallReply('calculator', { expression: '2+2' }, `c${Math.random()}`) : textReply('final'),
    );
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input, events } = runInput('calculate forever', { agentStrategy: 'single_agent' });
    await orchestrator.execute(input);
    const issues = evaluation(events)!.issues.join(' ');
    expect(issues).toContain('repeated');
    expect(issues).toContain('limit was reached');
  });

  it('flags policy violations: tools outside the allowed set', async () => {
    qwen.setScript((_body, i) => (i === 0 ? toolCallReply('get_current_time', {}) : textReply('ok')));
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input, events } = runInput('calculate 2+2', { agentStrategy: 'single_agent', tools: ['calculator'] });
    await orchestrator.execute(input);
    expect(evaluation(events)!.issues.join(' ')).toContain('outside its allowed or authorised tools');
  });
});

describe('client tools (OpenAI-compatible)', () => {
  it('offers client tools to the model and returns its calls without executing them', async () => {
    qwen.setScript((body) => (body.tools ? toolCallReply('lookup_order', { id: 'A1' }) : textReply('no tools')));
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input, events } = runInput('where is order A1?', {
      clientTools: [
        { name: 'lookup_order', description: 'Find an order', parameters: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
    });
    const out = await orchestrator.execute(input);
    expect(out.plan.agentStrategy).toBe('direct');
    expect(out.toolCalls).toEqual([{ id: 'call_lookup_order', name: 'lookup_order', arguments: '{"id":"A1"}' }]);
    expect(qwen.requests[0]!.tools?.[0]).toMatchObject({ function: { name: 'lookup_order' } });
    expect(types(events)).not.toContain('tool.started');
  });

  it('continues from client tool results in history', async () => {
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input } = runInput('where is order A1?', { clientTools: [{ name: 'lookup_order', description: '', parameters: {} }] });
    input.history.push(
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'lookup_order', arguments: '{"id":"A1"}' }] },
      { role: 'tool', content: '{"status":"shipped"}', toolCallId: 't1', name: 'lookup_order' },
    );
    qwen.setScript(() => textReply('Your order has shipped.'));
    const out = await orchestrator.execute(input);
    expect(out.output).toBe('Your order has shipped.');
    const sent = qwen.requests[0]!.messages.map((m) => m.role);
    expect(sent.slice(-3)).toEqual(['user', 'assistant', 'tool']);
  });
});

describe('context and agents', () => {
  it('includes workspace instructions and the conversation summary as bounded sources', async () => {
    const { orchestrator } = makeOrchestrator({ qwen });
    const { input, events } = runInput('hello');
    const withContext = {
      ...input,
      context: { workspaceInstructions: 'Always answer in British English.', conversationSummary: '- User is planning a launch in May.' },
    };
    await orchestrator.execute(withContext);
    const system = qwen.requests[0]!.messages[0]!.content as string;
    expect(system).toContain('Always answer in British English.');
    expect(system).toContain('User is planning a launch in May.');
    const built = events.find((e) => e.type === 'context.built');
    expect(built?.type === 'context.built' && built.data.sources.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['workspace', 'summary']),
    );
  });

  it('runs a workspace-defined agent by name with its output contract', async () => {
    const reviewer = agentFromSpec({
      id: 'reviewer',
      name: 'Reviewer',
      description: 'Reviews pull requests',
      instructions: 'You review code changes for bugs.',
      capabilities: ['code review'],
      tools: [],
      modelRole: 'agent',
      maxIterations: 2,
      outputContract: { format: 'text', description: 'List at most three findings.' },
    });
    const { orchestrator, store } = makeOrchestrator({ qwen, loadAgents: async () => [reviewer] });
    const out = await orchestrator.execute(runInput('Review my function', { agent: 'reviewer' }).input);
    expect(out.plan.agentStrategy).toBe('single_agent');
    expect(store.agents.map((a) => a.agentId)).toEqual(['reviewer']);
    const system = qwen.requests[0]!.messages[0]!.content as string;
    expect(system).toContain('You review code changes for bugs.');
    expect(system).toContain('List at most three findings.');

    const missing = await orchestrator.execute(runInput('x', { agent: 'nope' }).input).catch((e: unknown) => e);
    expect((missing as StageError).message).toContain('does not exist');
  });
});

describe('conversation summaries', () => {
  it('summarises only once enough messages accumulate, keeping the recent window verbatim', async () => {
    const msgs = Array.from({ length: SUMMARY_POLICY.triggerMessages }, (_, i) => ({
      position: i + 1,
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    expect(selectForSummary(msgs.slice(0, 5))).toBeNull();
    const picked = selectForSummary(msgs)!;
    expect(picked.length).toBe(SUMMARY_POLICY.triggerMessages - SUMMARY_POLICY.keepRecent);
    expect(picked.at(-1)!.position).toBe(SUMMARY_POLICY.triggerMessages - SUMMARY_POLICY.keepRecent);

    qwen.setScript(() => textReply('- The user is planning a May launch.'));
    const summary = await summarizeConversation(makeGateway(qwen), {
      model: 'qwen/qwen3:8b',
      previousSummary: '- Earlier facts',
      messages: picked,
    });
    expect(summary).toBe('- The user is planning a May launch.');
    expect(qwen.requests[0]!.messages[1]!.content).toContain('- Earlier facts');
  });
});
