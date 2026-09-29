import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ALL_SCOPES, type RunEventType, type ToolResult } from '@neuroflow/contracts';
import {
  builtinTools,
  defineTool,
  evaluateExpression,
  ToolExecutionError,
  ToolRegistry,
  ToolRuntime,
  type ApprovalGate,
  type ToolExecutionContext,
} from '../src';

function ctx(over: Partial<ToolExecutionContext> = {}) {
  const events: Array<{ type: RunEventType; data: unknown }> = [];
  const c: ToolExecutionContext = {
    runId: 'run-1',
    workspaceId: 'ws',
    userId: 'u',
    scopes: [...ALL_SCOPES],
    signal: new AbortController().signal,
    allowedTools: ['calculator', 'get_current_time', 'flaky', 'slow', 'dangerous', 'writer', 'big'],
    emit: (type, data) => events.push({ type, data }),
    ...over,
  };
  return { c, events };
}

let flakyCalls = 0;
let writerCalls = 0;
const flaky = defineTool({
  name: 'flaky',
  description: 'fails once',
  input: z.object({}),
  riskLevel: 'low',
  requiresApproval: false,
  sideEffects: false,
  permissions: [],
  timeoutMs: 500,
  maxRetries: 2,
  async execute() {
    if (flakyCalls++ === 0) throw new ToolExecutionError('transient', true);
    return { ok: true };
  },
});
const writer = defineTool({
  name: 'writer',
  description: 'side effect that fails retryably',
  input: z.object({}),
  riskLevel: 'medium',
  requiresApproval: false,
  sideEffects: true,
  permissions: ['memory:write'],
  timeoutMs: 500,
  maxRetries: 3,
  async execute() {
    writerCalls++;
    throw new ToolExecutionError('transient', true);
  },
});
const slow = defineTool({
  name: 'slow',
  description: 'never finishes',
  input: z.object({}),
  riskLevel: 'low',
  requiresApproval: false,
  sideEffects: false,
  permissions: [],
  timeoutMs: 50,
  maxRetries: 0,
  execute: () => new Promise(() => {}),
});
const dangerous = defineTool({
  name: 'dangerous',
  description: 'requires approval',
  input: z.object({ target: z.string() }),
  riskLevel: 'high',
  requiresApproval: true,
  sideEffects: true,
  permissions: [],
  timeoutMs: 500,
  execute: vi.fn(async ({ target }: { target: string }) => ({ deleted: target })),
});
const big = defineTool({
  name: 'big',
  description: 'large output',
  input: z.object({}),
  riskLevel: 'low',
  requiresApproval: false,
  sideEffects: false,
  permissions: [],
  timeoutMs: 500,
  maxResultChars: 100,
  execute: async () => ({ text: 'x'.repeat(10_000) }),
});

const registry = new ToolRegistry().registerAll([...builtinTools, flaky, writer, slow, dangerous, big]);

function gate(decision: { approved: boolean } | 'timeout'): ApprovalGate {
  return { wait: async () => decision };
}

describe('ToolRegistry', () => {
  it('exposes JSON Schema contracts', () => {
    const spec = registry.specs(['calculator'])[0]!;
    expect(spec.inputSchema).toMatchObject({
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    });
    expect(registry.describe().find((d) => d.name === 'dangerous')).toMatchObject({
      riskLevel: 'high',
      requiresApproval: true,
    });
  });

  it('rejects duplicate or invalid names', () => {
    expect(() => new ToolRegistry().registerAll([flaky, flaky])).toThrow();
    expect(() => new ToolRegistry().register({ ...flaky, name: 'Bad Name' })).toThrow();
  });
});

describe('ToolRuntime', () => {
  const rt = new ToolRuntime(registry);

  it('executes a valid call and emits observable events', async () => {
    const { c, events } = ctx();
    const res = await rt.execute({ id: 't1', name: 'calculator', arguments: '{"expression":"2*(3+4)"}' }, c);
    expect(res).toMatchObject({ status: 'success', data: { result: 14 } });
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.completed']);
  });

  it('rejects unknown tools', async () => {
    const res = await rt.execute({ id: 't', name: 'rm_rf', arguments: '{}' }, ctx().c);
    expect(res.error?.code).toBe('unknown_tool');
  });

  it('rejects malformed JSON and schema violations without executing', async () => {
    const a = await rt.execute({ id: 't', name: 'calculator', arguments: '{not json' }, ctx().c);
    expect(a.error?.code).toBe('invalid_arguments');
    const b = await rt.execute({ id: 't', name: 'calculator', arguments: '{"expression":42}' }, ctx().c);
    expect(b.error?.code).toBe('invalid_arguments');
    expect(b.error?.message).toContain('expression');
  });

  it('denies tools outside the run policy or principal scopes', async () => {
    const notAllowed = await rt.execute(
      { id: 't', name: 'calculator', arguments: '{"expression":"1"}' },
      ctx({ allowedTools: [] }).c,
    );
    expect(notAllowed).toMatchObject({ status: 'denied', error: { code: 'unauthorized' } });
    const noScope = await rt.execute({ id: 't', name: 'writer', arguments: '{}' }, ctx({ scopes: ['tools:execute'] }).c);
    expect(noScope).toMatchObject({ status: 'denied', error: { code: 'unauthorized' } });
    expect(writerCalls).toBe(0);
  });

  it('requires approval for consequential tools and fails closed', async () => {
    (dangerous.execute as ReturnType<typeof vi.fn>).mockClear();
    const noGate = await rt.execute({ id: 'd1', name: 'dangerous', arguments: '{"target":"x"}' }, ctx().c);
    expect(noGate.status).toBe('denied');

    const denied = await new ToolRuntime(registry, { approvals: gate({ approved: false }) }).execute(
      { id: 'd2', name: 'dangerous', arguments: '{"target":"x"}' },
      ctx().c,
    );
    expect(denied.error?.code).toBe('approval_denied');

    const timedOut = await new ToolRuntime(registry, { approvals: gate('timeout') }).execute(
      { id: 'd3', name: 'dangerous', arguments: '{"target":"x"}' },
      ctx().c,
    );
    expect(timedOut.error?.code).toBe('approval_timeout');
    expect(dangerous.execute).not.toHaveBeenCalled();

    const { c, events } = ctx();
    const approved = await new ToolRuntime(registry, { approvals: gate({ approved: true }) }).execute(
      { id: 'd4', name: 'dangerous', arguments: '{"target":"x"}' },
      c,
    );
    expect(approved).toMatchObject({ status: 'success', data: { deleted: 'x' } });
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'approval.requested', 'approval.resolved', 'tool.completed']);
  });

  it('times out slow tools', async () => {
    const res = await rt.execute({ id: 't', name: 'slow', arguments: '{}' }, ctx().c);
    expect(res).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
  });

  it('retries side-effect-free tools but never side-effecting ones', async () => {
    flakyCalls = 0;
    const ok = await rt.execute({ id: 't', name: 'flaky', arguments: '{}' }, ctx().c);
    expect(ok).toMatchObject({ status: 'success', attempts: 2 });
    writerCalls = 0;
    const failed = await rt.execute({ id: 't', name: 'writer', arguments: '{}' }, ctx().c);
    expect(failed.status).toBe('error');
    expect(writerCalls).toBe(1);
  });

  it('bounds large results', async () => {
    const res = await rt.execute({ id: 't', name: 'big', arguments: '{}' }, ctx().c);
    expect(res.truncated).toBe(true);
    expect(JSON.stringify(res.data).length).toBeLessThan(200);
  });

  it('does not re-run completed side-effecting calls on recovery', async () => {
    const previous: ToolResult = { toolCallId: 'd9', name: 'dangerous', status: 'success', data: { deleted: 'y' }, durationMs: 1, attempts: 1, truncated: false };
    (dangerous.execute as ReturnType<typeof vi.fn>).mockClear();
    const recorder = {
      start: vi.fn(async () => {}),
      approval: vi.fn(async () => {}),
      finish: vi.fn(async () => {}),
      findCompleted: vi.fn(async () => previous),
    };
    const res = await new ToolRuntime(registry, { recorder, approvals: gate({ approved: true }) }).execute(
      { id: 'd9', name: 'dangerous', arguments: '{"target":"y"}' },
      ctx().c,
    );
    expect(res).toBe(previous);
    expect(dangerous.execute).not.toHaveBeenCalled();
  });

  it('reports cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await rt.execute({ id: 't', name: 'calculator', arguments: '{"expression":"1"}' }, ctx({ signal: ac.signal }).c);
    expect(res.status).toBe('cancelled');
  });
});

describe('calculator', () => {
  it('evaluates safely', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('2^3^2')).toBe(512);
    expect(evaluateExpression('-(1+2)*sqrt(16)')).toBe(-12);
    expect(evaluateExpression('max(1, 5, 3) + pi - pi')).toBe(5);
    expect(() => evaluateExpression('process.exit()')).toThrow();
    expect(() => evaluateExpression('1/0')).toThrow();
  });
});
