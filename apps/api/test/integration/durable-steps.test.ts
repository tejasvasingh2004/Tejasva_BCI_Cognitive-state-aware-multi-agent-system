import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '@neuroflow/contracts';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { defaultScript, textReply, toolCallReply } from '@neuroflow/models/testing';
import { api, runEvents, startHarness, text, type Harness } from './harness';

const reachable = await isPostgresReachable();

/** Phase 3 gate: a worker killed mid-run → the run resumes on a new worker from its last completed step. */
describe.skipIf(!reachable)('durable steps', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    h.qwen.setScript((body, i) => {
      if (body.response_format) return defaultScript(body, i);
      const last = body.messages.at(-1);
      if (last?.role === 'tool') {
        // The final answer streams slowly, so the worker can be interrupted in the middle of it.
        return textReply(`The result is ${String(last.content).slice(0, 40)}. This answer streams slowly on purpose.`, { chunkSize: 4, chunkDelayMs: 60 });
      }
      if (body.tools?.length) return toolCallReply('calculator', { expression: '6*7' }, 'call_durable_1');
      return defaultScript(body, i);
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('resumes from the last completed step: no completed model call or tool call is repeated', async () => {
    const before = h.qwen.requests.length;
    const { run } = await (
      await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'calculate 6*7 durable' }], agentStrategy: 'single_agent', tools: ['calculator'] } })
    ).json();

    let interrupted = false;
    const events: RunEvent[] = await runEvents(h, run.id, (e) => {
      // Kill the worker while the second model call (the final answer) is streaming.
      if (e.type === 'response.delta' && !interrupted) {
        interrupted = true;
        h.shutdown.abort();
        setTimeout(() => void h.restartWorker(), 300);
      }
    });
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'run.started')).toHaveLength(2);
    expect(types.at(-1)).toBe('run.completed');

    // Provider requests for this run: the tool-calling step happened once; only the interrupted
    // final answer was asked for again.
    const mine = h.qwen.requests.slice(before).filter((r) => JSON.stringify(r.messages).includes('durable'));
    const firstStep = mine.filter((r) => r.tools?.length && r.messages.at(-1)?.role === 'user');
    const finalStep = mine.filter((r) => r.messages.at(-1)?.role === 'tool');
    expect(firstStep).toHaveLength(1);
    expect(finalStep).toHaveLength(2);

    // The completed step was replayed from its checkpoint, and the tool ran exactly once.
    const resumed = events.filter((e) => e.type === 'model.completed' && (e.data as { resumed?: boolean }).resumed);
    expect(resumed.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === 'tool.started')).toHaveLength(1);

    const detail = await (await api(h, `/v1/runs/${run.id}`)).json();
    expect(detail.run.attempt).toBe(2);
    expect(detail.run.output).toContain('The result is');
    expect(detail.run.output).toBe(text(events));
    // Usage counts each model call once: the replayed step is not billed again.
    const calls = await h.db.pool.query("SELECT count(*)::int AS n FROM model_calls WHERE run_id = $1 AND status = 'completed'", [run.id]);
    const steps = await h.db.pool.query('SELECT count(*)::int AS n FROM run_steps WHERE run_id = $1', [run.id]);
    expect(steps.rows[0].n).toBeGreaterThanOrEqual(2);
    expect(calls.rows[0].n).toBe(steps.rows[0].n);
  }, 60_000);
});
