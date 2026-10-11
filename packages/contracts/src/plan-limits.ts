/**
 * Plan limits as plain data (no runtime dependencies) so lightweight clients such as the
 * marketing site can import them; the API enforces exactly these values.
 */
export const PLANS = ['free', 'pro', 'team', 'enterprise'] as const;
export type Plan = (typeof PLANS)[number];

export type PlanLimits = {
  /** General API requests per minute (per workspace). */
  requestsPerMinute: number;
  /** Creating runs per minute: chat, Code Agent and OpenAI-compatible requests. */
  runsPerMinute: number;
  /** Sandbox terminal commands per minute. */
  commandsPerMinute: number;
  /** Runs queued or running at once in the workspace (admission control). */
  activeRunsPerWorkspace: number;
  /** Runs queued or running at once for one user. */
  activeRunsPerUser: number;
  /** Runs executing at the same time across all workers (fair share of the worker pool). */
  runningPerWorkspace: number;
  /** Model tokens per UTC day; null = unlimited. */
  dailyTokens: number | null;
  /** Queue priority (BullMQ: lower runs sooner). */
  queuePriority: number;
};

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    requestsPerMinute: 120,
    runsPerMinute: 10,
    commandsPerMinute: 10,
    activeRunsPerWorkspace: 2,
    activeRunsPerUser: 2,
    runningPerWorkspace: 1,
    dailyTokens: 200_000,
    queuePriority: 4,
  },
  pro: {
    requestsPerMinute: 600,
    runsPerMinute: 30,
    commandsPerMinute: 30,
    activeRunsPerWorkspace: 8,
    activeRunsPerUser: 4,
    runningPerWorkspace: 4,
    dailyTokens: 2_000_000,
    queuePriority: 2,
  },
  team: {
    requestsPerMinute: 1_200,
    runsPerMinute: 60,
    commandsPerMinute: 60,
    activeRunsPerWorkspace: 20,
    activeRunsPerUser: 8,
    runningPerWorkspace: 8,
    dailyTokens: 10_000_000,
    queuePriority: 1,
  },
  enterprise: {
    requestsPerMinute: 3_000,
    runsPerMinute: 120,
    commandsPerMinute: 120,
    activeRunsPerWorkspace: 50,
    activeRunsPerUser: 20,
    runningPerWorkspace: 20,
    dailyTokens: null,
    queuePriority: 1,
  },
};

/** Requests per minute allowed per client IP before authentication (login, public endpoints). */
export const ANONYMOUS_REQUESTS_PER_MINUTE = 60;
