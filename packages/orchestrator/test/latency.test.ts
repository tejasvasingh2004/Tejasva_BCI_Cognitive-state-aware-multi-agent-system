import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, ToolRegistry, ToolRuntime } from '@neuroflow/tools';
import { defaultScript, startMockOpenAIServer, textReply, type MockOpenAIServer } from '@neuroflow/models/testing';
import { Orchestrator, toolBatches } from '../src';
import { makeGateway, MemoryStore, runInput } from './helpers';

let qwen: MockOpenAIServer;

beforeAll(async () => {
  qwen = await startMockOpenAIServer();
});
afterAll(async () => {
  await qwen.close();
});
beforeEach(() => {
  qwen.setScript(defaultScript);
  qwen.requests.length = 0;
});

const log: string[] = [];
const slowLookup = defineTool({
  name: 'slow_lookup',
  description: 'Read-only lookup that takes a while.',
  input: z.object({ key: z.string() }),
  riskLevel: 'low',
  requiresApproval: false,
  sideEffects: false,
  permissions: [],
  timeoutMs: 5_000,
  async execute({ key }) {
    log.push(`start:${key}`);
    await new Promise((r) => setTimeout(r, 300));
    log.push(`end:${key}`);
    return { key, value: key.toUpperCase() };
  },
});
const writeNote = defineTool({
  name: 'write_note',
  description: 'Side-effecting write.',
  input: z.object({ text: z.string() }),
  riskLevel: 'low',
  requiresApproval: false,
  sideEffects: true,
  permissions: [],
  timeoutMs: 5_000,
  async execute({ text }) {
    log.push(`write:${text}`);
    return { ok: true };
  },
});

describe('parallel tool calls', () => {
  it('batches consecutive read-only calls and isolates side effects, keeping order', () => {
    const defs: Record<string, { sideEffects: boolean; requiresApproval: boolean }> = {
      a: { sideEffects: false, requiresApproval: false },
      w: { sideEffects: true, requiresApproval: false },
      x: { sideEffects: false, requiresApproval: true },
    };
    const call = (name: string, id: string) => ({ id, name, arguments: '{}' });
    const batches = toolBatches([call('a', '1'), call('a', '2'), call('w', '3'), call('a', '4'), call('x', '5'), call('nope', '6')], (n) => defs[n]);
    expect(batches.map((b) => b.map((c) => c.id))).toEqual([['1', '2'], ['3'], ['4'], ['5'], ['6']]);
  });

  it('runs independent lookups of one model turn at the same time and returns results in the model’s order', async () => {
    log.length = 0;
    let turn = 0;
    qwen.setScript((body) => {
      if (body.response_format) return defaultScript(body, 0);
      if (body.messages.at(-1)?.role === 'tool') {
        const results = body.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
        return textReply(`results: ${results.join(' | ')}`);
      }
      turn++;
      return {
        kind: 'stream',
        chunks: [
          {
            toolCalls: [
              { id: `t${turn}a`, name: 'slow_lookup', arguments: '{"key":"alpha"}' },
              { id: `t${turn}b`, name: 'slow_lookup', arguments: '{"key":"beta"}' },
              { id: `t${turn}c`, name: 'slow_lookup', arguments: '{"key":"gamma"}' },
              { id: `t${turn}d`, name: 'write_note', arguments: '{"text":"after"}' },
            ],
          },
        ],
      };
    });
    const registry = new ToolRegistry().registerAll([slowLookup, writeNote]);
    const orchestrator = new Orchestrator({ gateway: makeGateway(qwen), tools: new ToolRuntime(registry), store: new MemoryStore() });
    const { input } = runInput('look these up', { agentStrategy: 'single_agent', tools: ['slow_lookup', 'write_note'] });
    const started = Date.now();
    const out = await orchestrator.execute(input);
    const elapsed = Date.now() - started;

    // Three 300 ms lookups overlapped (sequentially they would take 900 ms or more).
    expect(elapsed).toBeLessThan(800);
    expect(log.slice(0, 3)).toEqual(['start:alpha', 'start:beta', 'start:gamma']);
    // The write waited for the lookups and ran after them.
    expect(log.at(-1)).toBe('write:after');
    // Results reach the model in the order it asked for them.
    const order = ['ALPHA', 'BETA', 'GAMMA'].map((v) => out.output.indexOf(v));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]!))).toBe(true);
  });
});
