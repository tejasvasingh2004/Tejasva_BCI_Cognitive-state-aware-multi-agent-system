import type { UsageHistory, UsageSource } from '@neuroflow/contracts';
import type { Queryable } from './client';

const DAY_MS = 86_400_000;

/** UTC midnight `days - 1` days before `now`: the first day of a `days`-long window ending today. */
export function usageWindowStart(days: number, now = new Date()): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

/** Classifies a run: Code Agent runs have a code_runs row; the rest by their source. */
const SOURCE_SQL = `CASE WHEN cr.run_id IS NOT NULL THEN 'code' WHEN r.source = 'workspace' THEN 'chat' ELSE 'api' END`;
const DAY_SQL = (col: string) => `to_char(date_trunc('day', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const money = (v: number) => Math.round(v * 1e6) / 1e6;

type Bucket = { runs: number; promptTokens: number; completionTokens: number; costUsd: number };
const empty = (): Bucket => ({ runs: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });

export const usageRepo = {
  /**
   * Usage of a workspace over the last `days` UTC days. Everything is scoped to runs created in
   * the window; run counts are bucketed by run creation day, tokens and cost by model-call day.
   */
  async history(db: Queryable, workspaceId: string, opts: { days: number; now?: Date }): Promise<UsageHistory> {
    const now = opts.now ?? new Date();
    const from = usageWindowStart(opts.days, now);
    const params = [workspaceId, from];

    const [runRows, callRows, modelRows, codeRows] = await Promise.all([
      db.query(
        `SELECT ${DAY_SQL('r.created_at')} AS day, ${SOURCE_SQL} AS source, r.status, count(*)::int AS runs
           FROM runs r LEFT JOIN code_runs cr ON cr.run_id = r.id
          WHERE r.workspace_id = $1 AND r.created_at >= $2
          GROUP BY 1, 2, 3`,
        params,
      ),
      db.query(
        `SELECT ${DAY_SQL('mc.created_at')} AS day, ${SOURCE_SQL} AS source,
                sum(coalesce(mc.prompt_tokens, 0))::bigint AS prompt_tokens,
                sum(coalesce(mc.completion_tokens, 0))::bigint AS completion_tokens,
                sum(coalesce(mc.cost_usd, 0)) AS cost_usd
           FROM model_calls mc
           JOIN runs r ON r.id = mc.run_id
           LEFT JOIN code_runs cr ON cr.run_id = r.id
          WHERE r.workspace_id = $1 AND r.created_at >= $2
          GROUP BY 1, 2`,
        params,
      ),
      db.query(
        `SELECT mc.provider, mc.model,
                count(*)::int AS calls,
                count(*) FILTER (WHERE mc.status = 'failed')::int AS failed_calls,
                count(mc.fallback_from)::int AS fallbacks,
                sum(coalesce(mc.prompt_tokens, 0))::bigint AS prompt_tokens,
                sum(coalesce(mc.completion_tokens, 0))::bigint AS completion_tokens,
                sum(coalesce(mc.cost_usd, 0)) AS cost_usd,
                sum(mc.latency_ms)::bigint AS latency_sum,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY mc.latency_ms) AS p95_latency
           FROM model_calls mc
           JOIN runs r ON r.id = mc.run_id
          WHERE r.workspace_id = $1 AND r.created_at >= $2
          GROUP BY mc.provider, mc.model`,
        params,
      ),
      db.query(
        `WITH w AS (
           SELECT cr.code_workspace_id, cr.run_id, cr.tests_passed
             FROM code_runs cr JOIN runs r ON r.id = cr.run_id
            WHERE r.workspace_id = $1 AND r.created_at >= $2
         ), calls AS (
           SELECT mc.run_id,
                  sum(coalesce(mc.prompt_tokens, 0))::bigint AS prompt_tokens,
                  sum(coalesce(mc.completion_tokens, 0))::bigint AS completion_tokens,
                  sum(coalesce(mc.cost_usd, 0)) AS cost_usd
             FROM model_calls mc WHERE mc.run_id IN (SELECT run_id FROM w)
            GROUP BY mc.run_id
         )
         SELECT cw.id, rb.owner, rb.name,
                count(*)::int AS runs,
                count(*) FILTER (WHERE w.tests_passed)::int AS tests_passed,
                count(*) FILTER (WHERE w.tests_passed = false)::int AS tests_failed,
                coalesce(sum(calls.prompt_tokens), 0)::bigint AS prompt_tokens,
                coalesce(sum(calls.completion_tokens), 0)::bigint AS completion_tokens,
                coalesce(sum(calls.cost_usd), 0) AS cost_usd
           FROM w
           JOIN code_workspaces cw ON cw.id = w.code_workspace_id
           JOIN repository_bindings rb ON rb.id = cw.repository_id
           LEFT JOIN calls ON calls.run_id = w.run_id
          GROUP BY cw.id, rb.owner, rb.name
          ORDER BY cost_usd DESC, (coalesce(sum(calls.prompt_tokens), 0) + coalesce(sum(calls.completion_tokens), 0)) DESC
          LIMIT 20`,
        params,
      ),
    ]);

    // Every day of the window, so charts show gaps as zero rather than skipping them.
    const daily = new Map<string, Bucket>();
    for (let t = from.getTime(); t <= now.getTime(); t += DAY_MS) daily.set(new Date(t).toISOString().slice(0, 10), empty());
    const sources = new Map<UsageSource, Bucket>((['chat', 'code', 'api'] as const).map((s) => [s, empty()]));
    const totals = { ...empty(), completedRuns: 0, failedRuns: 0, cancelledRuns: 0 };

    for (const r of runRows.rows) {
      const runs = num(r.runs);
      totals.runs += runs;
      if (r.status === 'completed') totals.completedRuns += runs;
      else if (r.status === 'failed') totals.failedRuns += runs;
      else if (r.status === 'cancelled') totals.cancelledRuns += runs;
      const day = daily.get(r.day);
      if (day) day.runs += runs;
      sources.get(r.source)!.runs += runs;
    }
    for (const r of callRows.rows) {
      const add = (b: Bucket | undefined) => {
        if (!b) return;
        b.promptTokens += num(r.prompt_tokens);
        b.completionTokens += num(r.completion_tokens);
        b.costUsd += num(r.cost_usd);
      };
      add(totals);
      add(daily.get(r.day));
      add(sources.get(r.source));
    }

    const byModel = modelRows.rows
      .map((r) => ({
        provider: String(r.provider),
        model: String(r.model),
        calls: num(r.calls),
        failedCalls: num(r.failed_calls),
        fallbacks: num(r.fallbacks),
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
        costUsd: money(num(r.cost_usd)),
        latencySum: num(r.latency_sum),
        p95LatencyMs: Math.round(num(r.p95_latency)),
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens));
    const modelCalls = byModel.reduce((s, m) => s + m.calls, 0);
    const latencySum = byModel.reduce((s, m) => s + m.latencySum, 0);

    const round = (b: Bucket): Bucket => ({ ...b, costUsd: money(b.costUsd) });
    return {
      days: opts.days,
      from: from.toISOString(),
      to: now.toISOString(),
      totals: {
        ...round(totals),
        completedRuns: totals.completedRuns,
        failedRuns: totals.failedRuns,
        cancelledRuns: totals.cancelledRuns,
        modelCalls,
        failedModelCalls: byModel.reduce((s, m) => s + m.failedCalls, 0),
        fallbacks: byModel.reduce((s, m) => s + m.fallbacks, 0),
        avgLatencyMs: modelCalls ? Math.round(latencySum / modelCalls) : null,
      },
      daily: [...daily].map(([date, b]) => ({ date, ...round(b) })),
      byModel: byModel.map(({ latencySum: sum, fallbacks: _f, ...m }) => ({ ...m, avgLatencyMs: m.calls ? Math.round(sum / m.calls) : 0 })),
      bySource: [...sources].map(([source, b]) => ({ source, ...round(b) })),
      byCodeWorkspace: codeRows.rows.map((r) => ({
        codeWorkspaceId: String(r.id),
        repository: `${r.owner}/${r.name}`,
        runs: num(r.runs),
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
        costUsd: money(num(r.cost_usd)),
        testsPassed: num(r.tests_passed),
        testsFailed: num(r.tests_failed),
      })),
    };
  },
};
