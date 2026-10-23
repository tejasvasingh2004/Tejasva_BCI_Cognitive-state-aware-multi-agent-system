import type { Queryable } from './client';

export type ModelOutcomeRow = { ref: string; samples: number; quality: number; costUsd?: number; latencyMs?: number };

/**
 * Measured outcomes per task class and primary model, for learned routing. Only direct and
 * single-agent runs count (their primary model is unambiguous). Quality is the run's last
 * evaluation score (or 1 / 0.5 / 0.2 for passed / needs refinement / failed verdicts without a
 * score); a failed run counts as 0. Runs without any quality signal are left out. Aggregates across
 * workspaces: numbers only, never content.
 */
export const routingStatsRepo = {
  async load(db: Queryable, opts: { days?: number } = {}): Promise<Record<string, ModelOutcomeRow[]>> {
    const { rows } = await db.query(
      `WITH outcomes AS (
         SELECT r.task_class,
                r.execution_plan->'models'->0->>'model' AS ref,
                CASE WHEN r.status = 'failed' THEN 0
                     ELSE COALESCE(e.score, CASE e.verdict WHEN 'passed' THEN 1 WHEN 'needs_refinement' THEN 0.5 WHEN 'failed' THEN 0.2 END)
                END AS quality,
                r.cost_usd,
                EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000 AS latency_ms
           FROM runs r
           LEFT JOIN LATERAL (
             SELECT score, verdict FROM evaluations WHERE run_id = r.id ORDER BY created_at DESC LIMIT 1
           ) e ON true
          WHERE r.created_at > now() - ($1::int * interval '1 day')
            AND r.status IN ('completed', 'failed')
            AND r.agent_strategy IN ('direct', 'single_agent')
            AND r.task_class IS NOT NULL
            AND r.execution_plan IS NOT NULL
       )
       SELECT task_class, ref, count(*)::int AS samples, avg(quality) AS quality,
              avg(cost_usd) AS cost_usd, avg(latency_ms) AS latency_ms
         FROM outcomes
        WHERE quality IS NOT NULL AND ref IS NOT NULL
        GROUP BY task_class, ref`,
      [opts.days ?? 14],
    );
    const out: Record<string, ModelOutcomeRow[]> = {};
    for (const r of rows) {
      (out[r.task_class as string] ??= []).push({
        ref: r.ref as string,
        samples: r.samples as number,
        quality: Number(r.quality),
        ...(r.cost_usd !== null ? { costUsd: Number(r.cost_usd) } : {}),
        ...(r.latency_ms !== null ? { latencyMs: Math.round(Number(r.latency_ms)) } : {}),
      });
    }
    return out;
  },
};
