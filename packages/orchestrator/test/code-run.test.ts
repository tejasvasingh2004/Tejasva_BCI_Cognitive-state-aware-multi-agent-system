import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_SCOPES, type RunEvent, type RunEventType, type RunRequest } from '@neuroflow/contracts';
import { createCodeTools, DockerSandbox, type RepoCheckout } from '@neuroflow/code';
import { checkoutFixture, createFixtureRepo, localCodeServices } from '@neuroflow/code/testing';
import { startMockOpenAIServer, textReply, toolCallReply, type MockOpenAIServer } from '@neuroflow/models/testing';
import { builtinTools, ToolRegistry, ToolRuntime } from '@neuroflow/tools';
import { Orchestrator, StageError } from '../src';
import { makeGateway, MemoryStore } from './helpers';

const sandbox = new DockerSandbox();
const dockerOk = await sandbox.available();
const CW = '11111111-1111-4111-8111-111111111111';

let qwen: MockOpenAIServer;
let fixture: Awaited<ReturnType<typeof createFixtureRepo>>;
let checkout: RepoCheckout;

beforeAll(async () => {
  qwen = await startMockOpenAIServer();
  fixture = await createFixtureRepo({
    'package.json': JSON.stringify({ name: 'calc', type: 'module', scripts: { test: 'node --test' } }),
    'src/math.js': 'export function add(a, b) {\n  return a - b;\n}\n',
    'test/math.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  });
  checkout = await checkoutFixture(fixture.remote, await mkdtemp(path.join(os.tmpdir(), 'nf-ws-')), 'cw');
});
afterAll(async () => {
  await qwen?.close();
  await fixture?.cleanup();
});

function setup(mode: 'review' | 'auto' | 'suggest' | 'restricted') {
  const services = localCodeServices({ checkout, sandbox });
  const registry = new ToolRegistry().registerAll([...builtinTools, ...createCodeTools(services)]);
  const orchestrator = new Orchestrator({
    gateway: makeGateway(qwen),
    tools: new ToolRuntime(registry, { approvals: { wait: async () => ({ approved: true }) } }),
    store: new MemoryStore(),
  });
  const events: RunEvent[] = [];
  let seq = 0;
  const input = {
    run: { id: 'run-1', workspaceId: 'ws', userId: 'u', conversationId: 'c', mode: 'standard' as const },
    request: { mode: 'standard', agentStrategy: 'auto', modelStrategy: 'auto', workspaceContext: { codeWorkspaceId: CW, approvalMode: mode } } as Omit<RunRequest, 'messages'>,
    history: [{ role: 'user' as const, content: 'Fix the failing add() test' }],
    scopes: [...ALL_SCOPES],
    signal: new AbortController().signal,
    emit: (type: RunEventType, data: unknown) => events.push({ runId: 'run-1', seq: ++seq, ts: '', type, data } as RunEvent),
    context: { code: { repository: 'Repository: acme/calc (branch main)\nProject: node', instructions: 'Keep functions small.' } },
  };
  return { orchestrator, services, events, input, registry };
}

describe('Code Agent run (orchestrator + real tools)', () => {
  it('only code runs see repository tools; Restricted runs only read-only ones', () => {
    const { registry } = setup('review');
    expect(registry.namesFor({ code: false })).not.toContain('read_file');
    expect(registry.namesFor({ code: true })).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'run_tests', 'push']));
    const ro = registry.namesFor({ code: true, readOnly: true });
    expect(ro).toEqual(expect.arrayContaining(['read_file', 'search_code', 'git_diff', 'get_issues']));
    expect(ro).not.toEqual(expect.arrayContaining(['edit_file']));
    expect(ro).not.toContain('run_tests');
    expect(ro).not.toContain('push');
  });

  it.skipIf(!dockerOk)('plans, edits, validates with real tests and repairs a failing change', async () => {
    let phase = 0;
    qwen.setScript((body) => {
      const sys = String(body.messages[0]?.content ?? '');
      if (body.response_format && sys.includes('You plan a coding task')) {
        return textReply(JSON.stringify({ summary: 'Fix add()', steps: ['Read src/math.js', 'Fix the operator in add()', 'Run the tests'] }));
      }
      if (body.response_format) return textReply(JSON.stringify({ verdict: 'passed', score: 0.9, issues: [] }));
      const all = JSON.stringify(body.messages);
      const repairing = all.includes('Validation failed');
      const last = body.messages.at(-1)!;
      if (!body.tools) return textReply('done');
      if (!repairing) {
        if (last.role === 'user' || last.role === 'system') return toolCallReply('read_file', { path: 'src/math.js' }, `c${++phase}`);
        if (last.role === 'tool' && String(last.content).includes('return a - b')) {
          // Deliberately wrong first fix, to exercise the validation/repair loop.
          return toolCallReply('edit_file', { path: 'src/math.js', edits: [{ find: 'return a - b;', replace: 'return a + b + 1;' }] }, `c${++phase}`);
        }
        return textReply('I changed add() to use addition.');
      }
      if (last.role === 'tool' && String(last.content).includes('"applied":true')) return textReply('Fixed the off-by-one; tests should pass now.');
      if (last.role === 'tool') return textReply('Tests pass.');
      return toolCallReply('edit_file', { path: 'src/math.js', edits: [{ find: 'return a + b + 1;', replace: 'return a + b;' }] }, `c${++phase}`);
    });
    const { orchestrator, events, input, services } = setup('auto');
    const out = await orchestrator.execute(input);
    const types = events.map((e) => e.type);

    expect(types).toEqual(expect.arrayContaining(['agent.plan.created', 'file.read', 'patch.generated', 'file.modified', 'test.started', 'test.completed']));
    const plan = events.find((e) => e.type === 'agent.plan.created');
    expect(plan?.type === 'agent.plan.created' && plan.data.steps).toHaveLength(3);
    const tests = events.filter((e) => e.type === 'test.completed').map((e) => (e.type === 'test.completed' ? e.data.passed : null));
    expect(tests).toEqual([false, true]);
    expect(await checkout.readText('src/math.js')).toContain('return a + b;');
    expect(out.output).toContain('Fixed the off-by-one');
    expect(services.store.codeRun.testsPassed).toBe(true);
    // The context engine received the repository sources.
    const built = events.find((e) => e.type === 'context.built');
    expect(built?.type === 'context.built' && built.data.sources.map((s) => s.kind)).toEqual(expect.arrayContaining(['repository', 'repository_instructions']));
    const evalEvent = events.filter((e) => e.type === 'evaluation.completed').at(-1);
    expect(evalEvent?.type === 'evaluation.completed' && evalEvent.data.issues).not.toContain('Tests are failing after the changes.');
  }, 240_000);

  it('Suggest mode never changes files and never runs validation', async () => {
    qwen.setScript((body) => {
      if (body.response_format) return textReply(JSON.stringify({ steps: ['Change add'] }));
      const last = body.messages.at(-1)!;
      if (last.role === 'tool') return textReply('Proposed a change for your review.');
      return toolCallReply('edit_file', { path: 'src/math.js', edits: [{ find: 'return a + b;', replace: 'return b + a;' }] });
    });
    const { orchestrator, events, input, services } = setup('suggest');
    await orchestrator.execute(input);
    expect(events.map((e) => e.type)).not.toContain('file.modified');
    expect(events.map((e) => e.type)).not.toContain('test.started');
    expect(services.store.patches.at(-1)!.status).toBe('proposed');
    expect(await checkout.readText('src/math.js')).toContain('return a + b;');
  });

  it('is bounded: a model that keeps editing cannot run forever', async () => {
    qwen.setScript((body) => {
      if (body.response_format) return textReply(JSON.stringify({ steps: ['x'] }));
      return body.tools ? toolCallReply('git_status', {}, `s${Math.random()}`) : textReply('stopped');
    });
    const { orchestrator, events, input } = setup('review');
    const out = await orchestrator.execute(input).catch((e: unknown) => e);
    // Either finished with a forced final answer or stopped by a budget — never unbounded.
    if (out instanceof StageError) expect(String(out.message)).toMatch(/budget/);
    expect(events.filter((e) => e.type === 'tool.started').length).toBeLessThanOrEqual(80);
  });
});
