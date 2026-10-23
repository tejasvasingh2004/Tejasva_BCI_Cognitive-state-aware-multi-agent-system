import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NeuroFlow, NeuroFlowError, type RunEvent } from '@neuroflow/sdk';
import { defaultScript, textReply, toolCallReply } from '@neuroflow/models/testing';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { API_KEY, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();

/** The TypeScript SDK against the real API, queue, worker and orchestrator. */
describe.skipIf(!reachable)('TypeScript SDK', () => {
  let h: Harness;
  let nf: NeuroFlow;

  beforeAll(async () => {
    h = await startHarness();
    nf = new NeuroFlow({ apiKey: API_KEY, baseUrl: h.baseUrl });
    // "forget" makes the mock model call delete_memory, a high-risk tool that needs approval.
    h.qwen.setScript((body, i) => {
      const last = body.messages.at(-1);
      const tools = new Set((body.tools ?? []).map((t) => t.function.name));
      if (last?.role === 'tool') return textReply(`Tool said: ${String(last.content).slice(0, 80)}`);
      if (tools.has('delete_memory') && /\bforget\b/i.test(String(last?.content))) return toolCallReply('delete_memory', { id: randomUUID() });
      return defaultScript(body, i);
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('runs a task and returns the final run', async () => {
    const events: string[] = [];
    const run = await nf.runs.run({ agentStrategy: 'direct', messages: [{ role: 'user', content: 'hello from the sdk' }] }, { onEvent: (e: RunEvent) => events.push(e.type) });
    expect(run.status).toBe('completed');
    expect(run.output).toContain('hello from the sdk');
    expect(run.usage?.totalTokens).toBeGreaterThan(0);
    expect(events[0]).toBe('run.created');
    expect(events.at(-1)).toBe('run.completed');
  });

  it('streams the answer text', async () => {
    const stream = nf.runs.stream({ agentStrategy: 'direct', messages: [{ role: 'user', content: 'stream this' }] });
    let text = '';
    let r = await stream.next();
    while (!r.done) {
      text += r.value;
      r = await stream.next();
    }
    expect(text).toContain('stream this');
    expect(r.value.output).toBe(text);
  });

  it('answers an approval request through the callback', async () => {
    const asked: string[] = [];
    const run = await nf.runs.run(
      { agentStrategy: 'single_agent', tools: ['delete_memory'], messages: [{ role: 'user', content: 'please forget my old note' }] },
      {
        onApproval: (req) => {
          asked.push(`${req.name}:${req.riskLevel}`);
          return { approved: false, reason: 'not now' };
        },
      },
    );
    expect(asked).toEqual(['delete_memory:high']);
    expect(run.status).toBe('completed');
    expect(run.output).toMatch(/Tool said:/);
  });

  it('is idempotent with the same key and reports API errors as NeuroFlowError', async () => {
    const key = randomUUID();
    const a = await nf.runs.create({ messages: [{ role: 'user', content: 'once' }] }, { idempotencyKey: key });
    const b = await nf.runs.create({ messages: [{ role: 'user', content: 'once' }] }, { idempotencyKey: key });
    expect(b.run.id).toBe(a.run.id);
    await nf.runs.wait(a.run.id);

    const err = await nf.runs.get(randomUUID()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeuroFlowError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
    const bad = new NeuroFlow({ apiKey: 'nf_wrong_key_00000000000000000000', baseUrl: h.baseUrl, maxRetries: 0 });
    await expect(bad.runs.get(a.run.id)).rejects.toMatchObject({ status: 401 });
  });
});
