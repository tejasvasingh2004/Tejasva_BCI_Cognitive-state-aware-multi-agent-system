import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunRequest } from '@neuroflow/contracts';
import { auditRepo, budgetsRepo, conversationsRepo, executionRepo, runsRepo, seedDev } from '@neuroflow/db';
import { createTestDatabase, isPostgresReachable } from '@neuroflow/db/testing';
import { BudgetService, createRedis, pingRedis, SpendMeter, spendLimitMessage, type Redis } from '../src';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/3';
const redisProbe = createRedis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
const reachable = (await isPostgresReachable()) && (await redisProbe.connect().then(() => pingRedis(redisProbe), () => false));
redisProbe.disconnect();

describe.skipIf(!reachable)('dollar budgets (Redis + Postgres)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let redis: Redis;
  let ids: { userId: string; workspaceId: string };
  let runId: string;
  let prefix: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    redis = createRedis(TEST_REDIS_URL);
    ids = await seedDev(db.pool);
    const conv = await conversationsRepo.create(db.pool, ids);
    const { run } = await runsRepo.create(db.pool, {
      ...ids,
      conversationId: conv.id,
      request: RunRequest.parse({ messages: [{ role: 'user', content: 'x' }] }),
      source: 'workspace',
      scopes: [],
    });
    runId = run.id;
  });
  afterAll(async () => {
    redis.disconnect();
    await db.drop();
  });
  beforeEach(async () => {
    // A fresh counter namespace per test; Postgres keeps accumulating, which is what seeding reads.
    prefix = `nf:test:spend:${Math.random().toString(36).slice(2)}:`;
    await db.pool.query('DELETE FROM model_calls');
    await db.pool.query('DELETE FROM workspace_budgets');
    await db.pool.query('DELETE FROM audit_events');
  });

  const call = (costUsd: number | undefined, providerKeyId?: string) =>
    executionRepo.recordModelCall(db.pool, {
      runId,
      role: 'agent',
      provider: 'groq',
      model: 'groq/llama-3.3-70b-versatile',
      status: 'completed',
      latencyMs: 10,
      attempts: 1,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, ...(costUsd !== undefined ? { costUsd } : {}) },
      ...(providerKeyId ? { providerKeyId } : {}),
    });

  it('seeds a missing counter from recorded calls, then adds to it', async () => {
    await call(0.4);
    await call(0.35);
    const meter = new SpendMeter(redis, db.pool, prefix);
    const target = { scope: 'workspace_month' as const, workspaceId: ids.workspaceId };
    expect(await meter.get(target)).toBeCloseTo(0.75, 6);
    await call(0.25);
    expect(await meter.add([target], 0.25)).toEqual([1]);
    expect(await meter.get(target)).toBeCloseTo(1, 6);
    // A counter that does not exist yet is not created by add: the next read seeds it, including the call.
    const day = { scope: 'workspace_day' as const, workspaceId: ids.workspaceId };
    expect(await meter.add([day], 5)).toEqual([null]);
    expect(await meter.get(day)).toBeCloseTo(1, 6);
    expect(await meter.once(target, 'alert')).toBe(true);
    expect(await meter.once(target, 'alert')).toBe(false);
  });

  it('blocks a workspace at its daily or monthly limit, and a key at its budget', async () => {
    const service = new BudgetService(db.pool, new SpendMeter(redis, db.pool, prefix), { cacheMs: 0 });
    expect(await service.workspaceBlock(ids.workspaceId)).toBeNull();
    await budgetsRepo.set(db.pool, ids.workspaceId, { monthlyLimitUsd: 10, dailyLimitUsd: 1, alertPercent: 80 }, ids.userId);
    await call(1.2);
    const block = await service.workspaceBlock(ids.workspaceId);
    expect(block).toMatchObject({ scope: 'workspace_day', limitUsd: 1 });
    expect(spendLimitMessage(block!)).toMatch(/daily spending limit of \$1\.00 is reached \(\$1\.20 spent\)/);

    await budgetsRepo.set(db.pool, ids.workspaceId, { monthlyLimitUsd: 10, dailyLimitUsd: null, alertPercent: 80 }, ids.userId);
    const keyId = (
      await db.pool.query(
        `INSERT INTO provider_keys (id, workspace_id, provider, label, ciphertext, hint, fingerprint, monthly_budget_usd)
         VALUES (gen_random_uuid(), $1, 'groq', 'k', 'x', 'abcd', 'fp', 2) RETURNING id`,
        [ids.workspaceId],
      )
    ).rows[0].id as string;
    expect(await service.callBlock(ids.workspaceId, keyId)).toBeNull();
    // As the worker does: store the call, then charge it.
    await call(2.5, keyId);
    await service.record({ workspaceId: ids.workspaceId, keyId, costUsd: 2.5 });
    expect(await service.callBlock(ids.workspaceId, keyId)).toMatchObject({ scope: 'key_month', limitUsd: 2, keyId });
    // Other keys and platform-key calls are still allowed.
    expect(await service.callBlock(ids.workspaceId)).toBeNull();
  });

  it('records spend and writes one alert and one exceeded audit event per period', async () => {
    const service = new BudgetService(db.pool, new SpendMeter(redis, db.pool, prefix), { cacheMs: 0 });
    await budgetsRepo.set(db.pool, ids.workspaceId, { monthlyLimitUsd: 1, dailyLimitUsd: null, alertPercent: 50 }, ids.userId);
    const spend = async (usd: number) => {
      await call(usd);
      await service.record({ workspaceId: ids.workspaceId, costUsd: usd });
    };
    await spend(0.3);
    await spend(0.3); // 0.6 ≥ 50 %
    await spend(0.1); // still above the threshold: no second alert
    await spend(0.5); // 1.2 ≥ limit
    await spend(0.1);
    const events = (await auditRepo.list(db.pool, ids.workspaceId, { limit: 20 })).filter((e) => e.action.startsWith('budget.'));
    expect(events.map((e) => e.action).sort()).toEqual(['budget.exceeded', 'budget.threshold_reached']);
    expect(events.find((e) => e.action === 'budget.exceeded')?.metadata).toMatchObject({ scope: 'workspace_month', limitUsd: 1 });
    expect(await budgetsRepo.unpricedCalls(db.pool, ids.workspaceId)).toBe(0);
    await call(undefined);
    expect(await budgetsRepo.unpricedCalls(db.pool, ids.workspaceId)).toBe(1);
  });
});
