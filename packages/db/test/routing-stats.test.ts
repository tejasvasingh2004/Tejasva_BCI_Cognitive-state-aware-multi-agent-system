import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authRepo, routingStatsRepo } from '../src';
import { createTestDatabase, isPostgresReachable } from '../src/testing';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('routing stats (learned routing input)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let ids: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await authRepo.ensureUserWithWorkspace(db.pool, { email: 'rs@example.test', displayName: 'R', workspaceName: 'R' });
  });
  afterAll(async () => {
    await db?.drop();
  });

  const run = async (o: { model: string; taskClass: string; strategy: string; status: 'completed' | 'failed'; cost?: number; durationMs?: number; evaluation?: { verdict: string; score?: number } }) => {
    const plan = { taskClass: o.taskClass, agentStrategy: o.strategy, models: [{ role: 'primary', model: o.model }] };
    const { rows } = await db.pool.query(
      `INSERT INTO runs (workspace_id, user_id, mode, status, requested_agent_strategy, requested_model_strategy, agent_strategy, task_class,
                         execution_plan, cost_usd, started_at, completed_at)
       VALUES ($1, $2, 'standard', $3, 'auto', 'auto', $4, $5, $6, $7, now() - ($8::int * interval '1 millisecond'), now()) RETURNING id`,
      [ids.workspaceId, ids.userId, o.status, o.strategy, o.taskClass, JSON.stringify(plan), o.cost ?? null, o.durationMs ?? 1000],
    );
    if (o.evaluation) {
      await db.pool.query('INSERT INTO evaluations (run_id, kind, verdict, score) VALUES ($1, $2, $3, $4)', [rows[0].id, 'heuristic', o.evaluation.verdict, o.evaluation.score ?? null]);
    }
  };

  it('aggregates quality, cost and latency per task class and primary model', async () => {
    await run({ model: 'groq/a', taskClass: 'analysis', strategy: 'direct', status: 'completed', cost: 0.002, durationMs: 1000, evaluation: { verdict: 'passed', score: 0.9 } });
    await run({ model: 'groq/a', taskClass: 'analysis', strategy: 'single_agent', status: 'completed', cost: 0.004, durationMs: 3000, evaluation: { verdict: 'needs_refinement' } });
    // A failed run counts as quality 0.
    await run({ model: 'groq/a', taskClass: 'analysis', strategy: 'direct', status: 'failed', cost: 0.003, durationMs: 2000 });
    // Not counted: no quality signal, multi-agent strategy.
    await run({ model: 'groq/a', taskClass: 'analysis', strategy: 'direct', status: 'completed' });
    await run({ model: 'groq/a', taskClass: 'analysis', strategy: 'supervisor', status: 'completed', evaluation: { verdict: 'passed', score: 1 } });
    await run({ model: 'qwen/b', taskClass: 'conversational', strategy: 'direct', status: 'completed', evaluation: { verdict: 'failed' } });

    const stats = await routingStatsRepo.load(db.pool);
    expect(stats.analysis).toHaveLength(1);
    const a = stats.analysis![0]!;
    expect(a).toMatchObject({ ref: 'groq/a', samples: 3 });
    expect(a.quality).toBeCloseTo((0.9 + 0.5 + 0) / 3, 5);
    expect(a.costUsd).toBeCloseTo(0.003, 6);
    expect(a.latencyMs).toBeGreaterThanOrEqual(1900);
    expect(stats.conversational).toEqual([expect.objectContaining({ ref: 'qwen/b', samples: 1 })]);
    // Scores are stored as single-precision reals.
    expect(stats.conversational![0]!.quality).toBeCloseTo(0.2, 5);
  });
});
