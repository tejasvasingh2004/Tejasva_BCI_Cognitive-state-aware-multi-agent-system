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
