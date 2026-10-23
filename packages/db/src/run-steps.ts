import type { Queryable } from './client';

/** Checkpoints of a run's completed steps (model calls), for resuming after an interruption. */
export const runStepsRepo = {
  async save(db: Queryable, runId: string, key: string, kind: string, result: unknown): Promise<void> {
    await db.query('INSERT INTO run_steps (run_id, step_key, kind, result) VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, step_key) DO NOTHING', [
      runId,
      key,
      kind,
      JSON.stringify(result),
    ]);
  },

  async load(db: Queryable, runId: string): Promise<Map<string, unknown>> {
    const { rows } = await db.query('SELECT step_key, result FROM run_steps WHERE run_id = $1', [runId]);
    return new Map(rows.map((r) => [r.step_key as string, r.result as unknown]));
  },
};
