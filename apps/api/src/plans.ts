import { PLAN_LIMITS, type Plan, type PlanLimits } from '@neuroflow/contracts';
import { workspaceRepo, type Pool } from '@neuroflow/db';
import type { ApiConfig } from './config';

const CACHE_TTL_MS = 30_000;

/**
 * Resolves a workspace's plan and effective limits. Plans are cached briefly per API process
 * (a plan change takes effect within 30 s on every server). Environment overrides exist for
 * operators and test environments.
 */
export class PlanResolver {
  private readonly cache = new Map<string, { plan: Plan; at: number }>();

  constructor(
    private readonly pool: Pool,
    private readonly config: Pick<
      ApiConfig,
      'RATE_LIMIT_PER_MINUTE' | 'RUN_RATE_LIMIT_PER_MINUTE' | 'MAX_ACTIVE_RUNS_PER_WORKSPACE' | 'MAX_ACTIVE_RUNS_PER_USER' | 'DAILY_TOKEN_QUOTA'
    >,
    private readonly now: () => number = Date.now,
  ) {}

  async plan(workspaceId: string): Promise<Plan> {
    const hit = this.cache.get(workspaceId);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.plan;
    const plan = (await workspaceRepo.getPlan(this.pool, workspaceId)) ?? 'free';
    this.cache.set(workspaceId, { plan, at: this.now() });
    return plan;
  }

  async limits(workspaceId: string): Promise<{ plan: Plan; limits: PlanLimits }> {
    const plan = await this.plan(workspaceId);
    return { plan, limits: this.apply(PLAN_LIMITS[plan]) };
  }

  /** Forget a cached plan (after an upgrade/downgrade on this server). */
  invalidate(workspaceId: string) {
    this.cache.delete(workspaceId);
  }

  private apply(base: PlanLimits): PlanLimits {
    const c = this.config;
    return {
      ...base,
      ...(c.RATE_LIMIT_PER_MINUTE ? { requestsPerMinute: c.RATE_LIMIT_PER_MINUTE, commandsPerMinute: c.RATE_LIMIT_PER_MINUTE } : {}),
      ...(c.RUN_RATE_LIMIT_PER_MINUTE ? { runsPerMinute: c.RUN_RATE_LIMIT_PER_MINUTE } : {}),
      ...(c.MAX_ACTIVE_RUNS_PER_WORKSPACE ? { activeRunsPerWorkspace: c.MAX_ACTIVE_RUNS_PER_WORKSPACE, runningPerWorkspace: c.MAX_ACTIVE_RUNS_PER_WORKSPACE } : {}),
      ...(c.MAX_ACTIVE_RUNS_PER_USER ? { activeRunsPerUser: c.MAX_ACTIVE_RUNS_PER_USER } : {}),
      ...(c.DAILY_TOKEN_QUOTA !== undefined ? { dailyTokens: c.DAILY_TOKEN_QUOTA === 0 ? null : c.DAILY_TOKEN_QUOTA } : {}),
    };
  }
}
