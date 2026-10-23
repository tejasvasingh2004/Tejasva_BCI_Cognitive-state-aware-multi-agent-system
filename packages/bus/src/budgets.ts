import { budgetPeriod, formatUsd, type BudgetScope } from '@neuroflow/contracts';
import { auditRepo, budgetsRepo, type Pool, type WorkspaceBudgetRow } from '@neuroflow/db';
import type { Redis } from './redis';

/** Spend is counted in micro-dollars so Redis can add it atomically as an integer. */
const MICRO = 1_000_000;
const TTL_S: Record<'day' | 'month', number> = { day: 3 * 24 * 3600, month: 40 * 24 * 3600 };

/** Adds to a counter only if it exists; a missing counter is seeded from Postgres on its next read. */
const INCR_IF_EXISTS = `if redis.call('exists', KEYS[1]) == 1 then return redis.call('incrby', KEYS[1], ARGV[1]) end return false`;

export type SpendTarget = { scope: 'workspace_day' | 'workspace_month'; workspaceId: string } | { scope: 'key_month'; keyId: string };

const periodOf = (scope: BudgetScope): 'day' | 'month' => (scope === 'workspace_day' ? 'day' : 'month');

/**
 * Model spend per workspace (UTC day and month) and per provider key (UTC month), shared by every
 * API and worker process. Postgres (`model_calls.cost_usd`) is the source of truth: a counter that
 * is missing (new period, Redis restart, eviction) is seeded from it on read, and workers add each
 * call's cost to counters that exist. A call recorded while its counter is being seeded can be
 * missed by the counter until it expires, so limits can be overshot by about one call's cost.
 */
export class SpendMeter {
  constructor(
    private readonly redis: Redis,
    private readonly pool: Pool,
    private readonly prefix = 'nf:spend:',
  ) {}

  private key(t: SpendTarget, at: Date): string {
    const id = t.scope === 'key_month' ? t.keyId : t.workspaceId;
    return `${this.prefix}${t.scope}:${id}:${budgetPeriod(periodOf(t.scope), at).id}`;
  }

  /** Spend (USD) of a target in the period containing `at`. */
  async get(t: SpendTarget, at = new Date()): Promise<number> {
    const key = this.key(t, at);
    let raw = await this.redis.get(key);
    if (raw === null) {
      const usd =
        t.scope === 'key_month'
          ? await budgetsRepo.keySpend(this.pool, t.keyId, at)
          : await budgetsRepo.workspaceSpend(this.pool, t.workspaceId, periodOf(t.scope), at);
      await this.redis.set(key, String(Math.round(usd * MICRO)), 'EX', TTL_S[periodOf(t.scope)], 'NX');
      raw = (await this.redis.get(key)) ?? '0';
    }
    return Number(raw) / MICRO;
  }

  /** Adds a recorded call's cost; returns each target's new spend, or null where the counter was not seeded. */
  async add(targets: SpendTarget[], usd: number, at = new Date()): Promise<(number | null)[]> {
    const micro = Math.round(usd * MICRO);
    if (!(micro > 0)) return targets.map(() => null);
    return Promise.all(
      targets.map(async (t) => {
        const v = await this.redis.eval(INCR_IF_EXISTS, 1, this.key(t, at), micro);
        return v === null || v === undefined ? null : Number(v) / MICRO;
      }),
    );
  }

  /** True only the first time it is called for this target, label and period (alert de-duplication). */
  async once(t: SpendTarget, label: string, at = new Date()): Promise<boolean> {
    return (await this.redis.set(`${this.key(t, at)}:${label}`, '1', 'EX', TTL_S[periodOf(t.scope)], 'NX')) === 'OK';
  }
}

/** A reached spending limit. */
export type SpendBlock = { scope: BudgetScope; limitUsd: number; spendUsd: number; resetsAt: Date; keyId?: string };

export function spendLimitMessage(b: SpendBlock): string {
  const what =
    b.scope === 'workspace_day'
      ? "This workspace's daily spending limit"
      : b.scope === 'workspace_month'
        ? "This workspace's monthly spending limit"
        : 'The monthly budget of this provider key';
  return `${what} of ${formatUsd(b.limitUsd)} is reached (${formatUsd(b.spendUsd)} spent). It resets at ${b.resetsAt.toISOString()}.`;
}

type Limits = { budget: WorkspaceBudgetRow; keyBudgets: Map<string, number>; at: number };

/**
 * Checks and records spend against a workspace's dollar budgets. The API checks workspace limits
 * when a run is admitted; workers check before every model call (workspace limits and the budget of
 * the key that would serve it) and record each call's cost, writing an audit event the first time
 * a limit's alert threshold or the limit itself is crossed in a period.
 */
export class BudgetService {
  private readonly cache = new Map<string, Limits>();

  constructor(
    private readonly pool: Pool,
    private readonly meter: SpendMeter,
    private readonly opts: {
      cacheMs?: number;
      now?: () => Date;
      /** Also notified of threshold and limit crossings (webhooks). */
      onAlert?: (workspaceId: string, type: 'budget.threshold_reached' | 'budget.exceeded', data: Record<string, unknown>) => Promise<void>;
    } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Budgets of a workspace, cached briefly per process (a change applies within `cacheMs`). */
  async limits(workspaceId: string): Promise<Limits> {
    const hit = this.cache.get(workspaceId);
    const now = Date.now();
    if (hit && now - hit.at < (this.opts.cacheMs ?? 15_000)) return hit;
    const [budget, keyBudgets] = await Promise.all([budgetsRepo.get(this.pool, workspaceId), budgetsRepo.keyBudgets(this.pool, workspaceId)]);
    const limits = { budget, keyBudgets, at: now };
    this.cache.set(workspaceId, limits);
    return limits;
  }

  invalidate(workspaceId: string) {
    this.cache.delete(workspaceId);
  }

  /** Current-period spend (USD) of a workspace or key. */
  spend(target: SpendTarget): Promise<number> {
    return this.meter.get(target, this.now());
  }

  /**
   * Cached budgets decide quickly that work may go ahead; a refusal is confirmed against freshly
   * read budgets, so a limit that was just raised (on any server) applies immediately.
   */
  private async confirmed(workspaceId: string, check: () => Promise<SpendBlock | null>): Promise<SpendBlock | null> {
    if (!(await check())) return null;
    this.invalidate(workspaceId);
    return check();
  }

  /** The first reached workspace limit (day before month), or null. */
  workspaceBlock(workspaceId: string): Promise<SpendBlock | null> {
    return this.confirmed(workspaceId, () => this.checkWorkspace(workspaceId));
  }

  /** Whether a model call may start: workspace limits, then the budget of the key that would serve it. */
  callBlock(workspaceId: string, keyId?: string): Promise<SpendBlock | null> {
    return this.confirmed(workspaceId, () => this.checkCall(workspaceId, keyId));
  }

  private async checkWorkspace(workspaceId: string): Promise<SpendBlock | null> {
    const at = this.now();
    const { budget } = await this.limits(workspaceId);
    for (const scope of ['workspace_day', 'workspace_month'] as const) {
      const limitUsd = scope === 'workspace_day' ? budget.dailyLimitUsd : budget.monthlyLimitUsd;
      if (limitUsd === null) continue;
      const spendUsd = await this.meter.get({ scope, workspaceId }, at);
      if (spendUsd >= limitUsd) return { scope, limitUsd, spendUsd, resetsAt: budgetPeriod(periodOf(scope), at).end };
    }
    return null;
  }

  private async checkCall(workspaceId: string, keyId?: string): Promise<SpendBlock | null> {
    const block = await this.checkWorkspace(workspaceId);
    if (block || !keyId) return block;
    const limitUsd = (await this.limits(workspaceId)).keyBudgets.get(keyId);
    if (limitUsd === undefined) return null;
    const at = this.now();
    const spendUsd = await this.meter.get({ scope: 'key_month', keyId }, at);
    return spendUsd >= limitUsd ? { scope: 'key_month', limitUsd, spendUsd, resetsAt: budgetPeriod('month', at).end, keyId } : null;
  }

  /** Records a completed call's cost and alerts once per period when a threshold is crossed. */
  async record(input: { workspaceId: string; keyId?: string; costUsd?: number }): Promise<void> {
    if (!input.costUsd || input.costUsd <= 0) return;
    const at = this.now();
    const { budget, keyBudgets } = await this.limits(input.workspaceId);
    const checks: { target: SpendTarget; limitUsd: number | null | undefined }[] = [
      { target: { scope: 'workspace_day', workspaceId: input.workspaceId }, limitUsd: budget.dailyLimitUsd },
      { target: { scope: 'workspace_month', workspaceId: input.workspaceId }, limitUsd: budget.monthlyLimitUsd },
      ...(input.keyId ? [{ target: { scope: 'key_month', keyId: input.keyId } as SpendTarget, limitUsd: keyBudgets.get(input.keyId) }] : []),
    ];
    await this.meter.add(
      checks.map((c) => c.target),
      input.costUsd,
      at,
    );
    for (const { target, limitUsd } of checks) {
      if (!limitUsd) continue;
      const spendUsd = await this.meter.get(target, at);
      const metadata = {
        scope: target.scope,
        limitUsd,
        spendUsd: Math.round(spendUsd * 100) / 100,
        period: budgetPeriod(periodOf(target.scope), at).id,
        ...(target.scope === 'key_month' ? { keyId: target.keyId } : {}),
      };
      const targetId = target.scope === 'key_month' ? target.keyId : input.workspaceId;
      const targetType = target.scope === 'key_month' ? 'provider_key' : 'workspace';
      if (spendUsd >= limitUsd && (await this.meter.once(target, 'exceeded', at))) {
        await auditRepo.record(this.pool, { action: 'budget.exceeded', workspaceId: input.workspaceId, actorVia: 'system', targetType, targetId, metadata });
        await this.opts.onAlert?.(input.workspaceId, 'budget.exceeded', metadata);
      } else if (spendUsd >= (limitUsd * budget.alertPercent) / 100 && spendUsd < limitUsd && (await this.meter.once(target, 'alert', at))) {
        await auditRepo.record(this.pool, {
          action: 'budget.threshold_reached',
          workspaceId: input.workspaceId,
          actorVia: 'system',
          targetType,
          targetId,
          metadata: { ...metadata, alertPercent: budget.alertPercent },
        });
        await this.opts.onAlert?.(input.workspaceId, 'budget.threshold_reached', { ...metadata, alertPercent: budget.alertPercent });
      }
    }
  }
}
