import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@neuroflow/contracts';
import { reduceRunEvents } from './run-view';

let seq = 0;
const ev = (type: RunEvent['type'], data: unknown): RunEvent =>
  ({ runId: 'r', seq: ++seq, ts: new Date(1_700_000_000_000 + seq * 100).toISOString(), type, data }) as RunEvent;

describe('reduceRunEvents', () => {
  it('derives phases, steps and text from real events only', () => {
    seq = 0;
    const view = reduceRunEvents([
      ev('run.created', { mode: 'standard' }),
      ev('run.started', { attempt: 1, queueLatencyMs: 4 }),
      ev('router.started', {}),
      ev('agent.started', { agentExecutionId: 'a1', agentId: 'assistant', name: 'Assistant', role: 'agent', model: 'qwen/qwen3:8b' }),
      ev('tool.started', { toolCallId: 't1', name: 'search_memory' }),
      ev('tool.completed', { toolCallId: 't1', name: 'search_memory', status: 'success', durationMs: 5, summary: '1 memory found' }),
      ev('response.delta', { text: 'Hello ' }),
      ev('response.delta', { text: 'world' }),
    ]);
    expect(view.status).toBe('running');
    expect(view.phase).toBe('Writing response');
    expect(view.text).toBe('Hello world');
    expect(view.toolsUsed).toEqual(['search_memory']);
    expect(view.steps.map((s) => [s.kind, s.status])).toEqual([
      ['router', 'active'],
      ['agent', 'active'],
      ['tool', 'done'],
    ]);
  });

  it('handles resets, approvals, completion and ignores duplicates', () => {
    seq = 0;
    const started = ev('run.started', { attempt: 1, queueLatencyMs: 0 });
    const view = reduceRunEvents([
      started,
      started,
      ev('response.delta', { text: 'draft' }),
      ev('response.reset', { reason: 'refine' }),
      ev('approval.requested', { toolCallId: 'x', name: 'delete_memory', riskLevel: 'high', arguments: {}, expiresAt: '' }),
      ev('approval.resolved', { toolCallId: 'x', approved: true }),
      ev('response.delta', { text: 'final' }),
      ev('run.completed', { durationMs: 10 }),
    ]);
    expect(view.text).toBe('final');
    expect(view.approvals).toEqual([]);
    expect(view.status).toBe('completed');
    expect(view.steps.every((s) => s.status !== 'active')).toBe(true);
  });

  it('marks failures', () => {
    seq = 0;
    const view = reduceRunEvents([
      ev('run.started', { attempt: 1, queueLatencyMs: 0 }),
      ev('router.started', {}),
      ev('run.failed', { error: { code: 'model_unavailable', message: 'Provider down' } }),
    ]);
    expect(view.status).toBe('failed');
    expect(view.error?.message).toBe('Provider down');
    expect(view.steps[0]!.status).toBe('failed');
  });
});
