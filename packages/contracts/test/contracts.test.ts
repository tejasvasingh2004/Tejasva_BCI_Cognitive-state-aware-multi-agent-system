import { describe, expect, it } from 'vitest';
import { parseModelRef, parseRunEvent, RunRequest, isTerminalEvent } from '../src';

describe('parseModelRef', () => {
  it('splits on the first slash only', () => {
    expect(parseModelRef('groq/qwen/qwen3-32b')).toEqual({ provider: 'groq', model: 'qwen/qwen3-32b' });
    expect(parseModelRef('qwen/qwen3:8b')).toEqual({ provider: 'qwen', model: 'qwen3:8b' });
  });

  it('rejects malformed refs', () => {
    expect(() => parseModelRef('qwen3')).toThrow();
    expect(() => parseModelRef('groq/')).toThrow();
  });
});

describe('RunRequest', () => {
  it('applies defaults', () => {
    const req = RunRequest.parse({ messages: [{ role: 'user', content: 'hi' }] });
    expect(req.mode).toBe('standard');
    expect(req.agentStrategy).toBe('auto');
    expect(req.modelStrategy).toBe('auto');
  });

  it('rejects empty message lists and oversized input', () => {
    expect(RunRequest.safeParse({ messages: [] }).success).toBe(false);
    expect(
      RunRequest.safeParse({ messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }).success,
    ).toBe(false);
  });
});

describe('parseRunEvent', () => {
  it('validates payloads per event type', () => {
    const ev = parseRunEvent({
      runId: 'r1',
      seq: 3,
      ts: new Date().toISOString(),
      type: 'response.delta',
      data: { text: 'hello' },
    });
    expect(ev.type).toBe('response.delta');
    expect(() =>
      parseRunEvent({ runId: 'r1', seq: 1, ts: 'now', type: 'response.delta', data: {} }),
    ).toThrow();
    expect(() =>
      parseRunEvent({ runId: 'r1', seq: 1, ts: 'now', type: 'made.up', data: {} }),
    ).toThrow();
  });

  it('identifies terminal events', () => {
    expect(isTerminalEvent({ type: 'run.completed' })).toBe(true);
    expect(isTerminalEvent({ type: 'model.completed' })).toBe(false);
  });
});
