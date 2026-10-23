import { budgetPeriod, type UpdateWorkspaceBudgetBody } from '@neuroflow/contracts';
import type { Queryable } from './client';

export type WorkspaceBudgetRow = { monthlyLimitUsd: number | null; dailyLimitUsd: number | null; alertPercent: number };

const NO_BUDGET: WorkspaceBudgetRow = { monthlyLimitUsd: null, dailyLimitUsd: null, alertPercent: 80 };
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Dollar budgets and the spend they are checked against. Spend is the sum of `model_calls.cost_usd`
 * (estimated from list prices) in a UTC day or month; Postgres is the source of truth and the Redis
 * spend meter (`@neuroflow/bus`) is a fast counter seeded from these sums.
 */
export const budgetsRepo = {
  async get(db: Queryable, workspaceId: string): Promise<WorkspaceBudgetRow> {
    const { rows } = await db.query('SELECT monthly_limit_usd, daily_limit_usd, alert_percent FROM workspace_budgets WHERE workspace_id = $1', [workspaceId]);
    const r = rows[0];
    if (!r) return NO_BUDGET;
    return { monthlyLimitUsd: numOrNull(r.monthly_limit_usd), dailyLimitUsd: numOrNull(r.daily_limit_usd), alertPercent: Number(r.alert_percent) };
  },

  async set(db: Queryable, workspaceId: string, body: UpdateWorkspaceBudgetBody, userId: string | null): Promise<WorkspaceBudgetRow> {
    await db.query(
      `INSERT INTO workspace_budgets (workspace_id, monthly_limit_usd, daily_limit_usd, alert_percent, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (workspace_id) DO UPDATE
         SET monthly_limit_usd = EXCLUDED.monthly_limit_usd, daily_limit_usd = EXCLUDED.daily_limit_usd,
             alert_percent = EXCLUDED.alert_percent, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [workspaceId, body.monthlyLimitUsd, body.dailyLimitUsd, body.alertPercent, userId],
    );
    return budgetsRepo.get(db, workspaceId);
  },

  /** Monthly budgets of a workspace's provider keys that have one, by key id. */
  async keyBudgets(db: Queryable, workspaceId: string): Promise<Map<string, number>> {
    const { rows } = await db.query('SELECT id, monthly_budget_usd FROM provider_keys WHERE workspace_id = $1 AND monthly_budget_usd IS NOT NULL', [workspaceId]);
    return new Map(rows.map((r) => [r.id as string, Number(r.monthly_budget_usd)]));
  },

  /** Recorded spend (USD) of a workspace in the UTC day or month containing `at`. */
  async workspaceSpend(db: Queryable, workspaceId: string, period: 'day' | 'month', at = new Date()): Promise<number> {
    const { start, end } = budgetPeriod(period, at);
    const { rows } = await db.query(
      'SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM model_calls WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3',
      [workspaceId, start, end],
    );
    return Number(rows[0]?.usd ?? 0);
  },

  /** Recorded spend (USD) through one provider key in the UTC month containing `at`. */
  async keySpend(db: Queryable, keyId: string, at = new Date()): Promise<number> {
    const { start, end } = budgetPeriod('month', at);
    const { rows } = await db.query(
      'SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM model_calls WHERE provider_key_id = $1 AND created_at >= $2 AND created_at < $3',
      [keyId, start, end],
    );
    return Number(rows[0]?.usd ?? 0);
  },

  /** Spend per provider key of a workspace this month (keys without spend are absent). */
  async keySpendByKey(db: Queryable, workspaceId: string, at = new Date()): Promise<Map<string, number>> {
    const { start, end } = budgetPeriod('month', at);
    const { rows } = await db.query(
      `SELECT provider_key_id, COALESCE(SUM(cost_usd), 0) AS usd FROM model_calls
        WHERE workspace_id = $1 AND provider_key_id IS NOT NULL AND created_at >= $2 AND created_at < $3
        GROUP BY provider_key_id`,
      [workspaceId, start, end],
    );
    return new Map(rows.map((r) => [r.provider_key_id as string, Number(r.usd)]));
  },

  /** Completed model calls this month with tokens but no price (they do not count toward limits). */
  async unpricedCalls(db: Queryable, workspaceId: string, at = new Date()): Promise<number> {
    const { start, end } = budgetPeriod('month', at);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM model_calls
        WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3
          AND status = 'completed' AND cost_usd IS NULL AND COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0) > 0`,
      [workspaceId, start, end],
    );
    return Number(rows[0]?.n ?? 0);
  },
};
