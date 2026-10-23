import { z } from 'zod';

/**
 * Dollar budgets. A workspace can cap its model spend per UTC day and per UTC calendar month, and
 * each of its own provider keys can have a monthly cap. Spend is the estimated cost of recorded
 * model calls (list prices from the model catalogue or `MODEL_PRICING`); calls to models without a
 * known price are counted separately and do not count toward the limits.
 */
const Usd = z.number().positive().max(1_000_000).multipleOf(0.01);

export const UpdateWorkspaceBudgetBody = z.object({
  /** USD per UTC calendar month; null removes the limit. */
  monthlyLimitUsd: Usd.nullable(),
  /** USD per UTC day; null removes the limit. */
  dailyLimitUsd: Usd.nullable(),
  /** Spend share (percent of a limit) at which an alert is recorded, once per period. */
  alertPercent: z.number().int().min(1).max(100).default(80),
});
export type UpdateWorkspaceBudgetBody = z.infer<typeof UpdateWorkspaceBudgetBody>;

export const WorkspaceBudget = z.object({
  monthlyLimitUsd: z.number().nullable(),
  dailyLimitUsd: z.number().nullable(),
  alertPercent: z.number(),
  spend: z.object({
    todayUsd: z.number(),
    monthUsd: z.number(),
    /** Model calls this month whose model has no known price (not counted toward limits). */
    unpricedCallsThisMonth: z.number(),
  }),
  /** Next UTC midnight and the first instant of next UTC month. */
  resets: z.object({ day: z.string(), month: z.string() }),
  canEdit: z.boolean(),
});
export type WorkspaceBudget = z.infer<typeof WorkspaceBudget>;

export const UpdateProviderKeyBody = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    /** USD per UTC calendar month for this key; null removes the limit. */
    monthlyBudgetUsd: Usd.nullable().optional(),
  })
  .refine((b) => b.label !== undefined || b.monthlyBudgetUsd !== undefined, { message: 'Nothing to update' });
export type UpdateProviderKeyBody = z.infer<typeof UpdateProviderKeyBody>;

/** Which limit a check or alert refers to. */
export const BudgetScope = z.enum(['workspace_day', 'workspace_month', 'key_month']);
export type BudgetScope = z.infer<typeof BudgetScope>;

/** Start of the UTC day / month containing `at`, and the start of the next one. */
export function budgetPeriod(period: 'day' | 'month', at = new Date()): { start: Date; end: Date; id: string } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  if (period === 'month') {
    return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)), id: at.toISOString().slice(0, 7) };
  }
  const d = at.getUTCDate();
  return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)), id: at.toISOString().slice(0, 10) };
}

export function formatUsd(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
