import { z } from 'zod';
import { PLANS } from './plan-limits';

export * from './plan-limits';

/** Subscription plan of a workspace (the tenant). Billing will set it; today an operator does. */
export const Plan = z.enum(PLANS);
export type Plan = z.infer<typeof Plan>;

export const WorkspaceUsage = z.object({
  plan: Plan,
  limits: z.object({
    requestsPerMinute: z.number(),
    runsPerMinute: z.number(),
    commandsPerMinute: z.number(),
    activeRunsPerWorkspace: z.number(),
    activeRunsPerUser: z.number(),
    runningPerWorkspace: z.number(),
    dailyTokens: z.number().nullable(),
  }),
  usage: z.object({
    tokensToday: z.number(),
    activeRuns: z.number(),
    /** When the daily token quota resets (UTC midnight). */
    resetsAt: z.string(),
  }),
});
export type WorkspaceUsage = z.infer<typeof WorkspaceUsage>;

/** Windows offered by the usage history endpoint (days, ending today, UTC). */
export const USAGE_WINDOWS = [7, 30, 90] as const;
export const UsageHistoryQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (USAGE_WINDOWS as readonly number[]).includes(d), { message: `days must be one of ${USAGE_WINDOWS.join(', ')}` })
    .default(30),
});

const Amounts = {
  runs: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  costUsd: z.number(),
};

/** Where a run came from: the chat workspace, the Code Agent, or the API (incl. OpenAI-compatible). */
export const UsageSource = z.enum(['chat', 'code', 'api']);
export type UsageSource = z.infer<typeof UsageSource>;

/**
 * Usage over a window, aggregated from recorded runs and model calls (the same numbers the
 * daily quota and, later, billing use). Runs are counted by creation day; tokens and cost come
 * from the model calls of those runs.
 */
export const UsageHistory = z.object({
  days: z.number(),
  /** Start of the window: UTC midnight `days - 1` days ago. */
  from: z.string(),
  to: z.string(),
  totals: z.object({
    ...Amounts,
    completedRuns: z.number(),
    failedRuns: z.number(),
    cancelledRuns: z.number(),
    modelCalls: z.number(),
    failedModelCalls: z.number(),
    fallbacks: z.number(),
    avgLatencyMs: z.number().nullable(),
  }),
  /** One entry per UTC day in the window, oldest first, including days without usage. */
  daily: z.array(z.object({ date: z.string(), ...Amounts })),
  byModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      calls: z.number(),
      failedCalls: z.number(),
      promptTokens: z.number(),
      completionTokens: z.number(),
      costUsd: z.number(),
      avgLatencyMs: z.number(),
      p95LatencyMs: z.number(),
    }),
  ),
  bySource: z.array(z.object({ source: UsageSource, ...Amounts })),
  byCodeWorkspace: z.array(
    z.object({
      codeWorkspaceId: z.string(),
      repository: z.string(),
      ...Amounts,
      testsPassed: z.number(),
      testsFailed: z.number(),
    }),
  ),
});
export type UsageHistory = z.infer<typeof UsageHistory>;
