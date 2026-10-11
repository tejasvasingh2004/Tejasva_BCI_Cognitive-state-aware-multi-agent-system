import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_SCOPES, type RunEvent } from '@neuroflow/contracts';
import { createRedis, UsageMeter } from '@neuroflow/bus';
import { authRepo } from '@neuroflow/db';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { defaultScript } from '@neuroflow/models/testing';
import { api, readSse, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();
const FREE_KEY = 'nf_free_plan_test_key_00000000000000';

/**
 * Plans drive rate limits, concurrency caps, daily token quotas and worker fairness. The harness
 * overrides are cleared here so the real plan limits apply.
 */
describe.skipIf(!reachable)('plans: rate limits, admission, quotas and fair scheduling', () => {
  let h: Harness;
  let freeWorkspace: string;
  const free = (path: string, init: Parameters<typeof api>[2] = {}) => api(h, path, { ...init, key: FREE_KEY });
  const events = async (runId: string): Promise<RunEvent[]> => (await readSse(await free(`/v1/runs/${runId}/events`))).map((d) => JSON.parse(d) as RunEvent);
  const startRun = (content: string) => free('/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content }] } });

  beforeAll(async () => {
    h = await startHarness({ RATE_LIMIT_PER_MINUTE: '', RUN_RATE_LIMIT_PER_MINUTE: '', MAX_ACTIVE_RUNS_PER_WORKSPACE: '', MAX_RUNNING_PER_WORKSPACE: '' });
    h.qwen.setScript(defaultScript);
    const ids = await authRepo.ensureUserWithWorkspace(h.db.pool, { email: 'free@example.test', displayName: 'Free User', workspaceName: 'Free workspace' });
    freeWorkspace = ids.workspaceId;
    await authRepo.createApiKey(h.db.pool, { ...ids, name: 'free', scopes: [...ALL_SCOPES], key: FREE_KEY });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('reports the plan, its limits and metered usage', async () => {
    const usage = await (await free('/v1/workspace/usage')).json();
    expect(usage).toMatchObject({
      plan: 'free',
      limits: { requestsPerMinute: 120, runsPerMinute: 10, activeRunsPerWorkspace: 2, runningPerWorkspace: 1, dailyTokens: 200_000 },
      usage: { tokensToday: 0, activeRuns: 0 },
    });
    expect(usage.limits.queuePriority).toBeUndefined();
    // The local dev workspace runs on the team plan.
    expect((await (await api(h, '/v1/workspace/usage')).json()).plan).toBe('team');
  });

  it('a free workspace executes one run at a time: the second waits for a fair-share slot', async () => {
    h.qwen.setScript((body, i) => {
      const last = String(body.messages.at(-1)?.content ?? '');
      return /first/.test(last) ? defaultScript({ ...body, messages: [{ role: 'user', content: 'slow' }] }, i) : defaultScript(body, i);
    });
    const a = (await (await startRun('first, slow please')).json()).run.id as string;
    const b = (await (await startRun('second')).json()).run.id as string;
    const [ea, eb] = await Promise.all([events(a), events(b)]);
    const ts = (events: RunEvent[], type: string) => Date.parse(events.find((e) => e.type === type)!.ts);
    expect(ea.at(-1)?.type).toBe('run.completed');
    expect(eb.at(-1)?.type).toBe('run.completed');
    // Run b only started once run a had finished (runningPerWorkspace = 1 on the free plan).
    expect(ts(eb, 'run.started')).toBeGreaterThanOrEqual(ts(ea, 'run.completed') - 50);
    h.qwen.setScript(defaultScript);
  }, 60_000);

  it('caps active runs per workspace with 429 + Retry-After', async () => {
    h.qwen.setScript(() => defaultScript({ messages: [{ role: 'user', content: 'slow' }] } as never, 0));
    const r1 = await startRun('one');
    const r2 = await startRun('two');
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const r3 = await startRun('three');
    expect(r3.status).toBe(429);
    expect(r3.headers.get('retry-after')).toBeTruthy();
    expect((await r3.json()).error.message).toMatch(/free plan allows 2 active runs/);
    for (const r of [r1, r2]) {
      const id = (await r.json()).run.id as string;
      await free(`/v1/runs/${id}/cancel`, { method: 'POST', json: {} });
      await events(id);
    }
    h.qwen.setScript(defaultScript);
  }, 60_000);

  it('enforces the daily model-token quota (metered by the worker)', async () => {
    const redis = createRedis(h.redisUrl);
    const meter = new UsageMeter(redis);
    const before = await meter.tokensToday(freeWorkspace);
    expect(before).toBeGreaterThan(0); // earlier runs in this file were metered by the worker
    await meter.addTokens(freeWorkspace, 200_000);
    redis.disconnect();
    const res = await startRun('over quota');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: 'quota_exceeded', details: { plan: 'free', dailyTokens: 200_000 } });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rate-limits requests per tenant with RateLimit headers and 429 + Retry-After', async () => {
    const first = await free('/v1/workspace/usage');
    expect(first.headers.get('ratelimit-limit')).toBe('120');
    let limited: Response | undefined;
    for (let i = 0; i < 130 && !limited; i++) {
      const r = await free('/v1/workspace/usage');
      if (r.status === 429) limited = r;
    }
    expect(limited).toBeDefined();
    expect(limited!.headers.get('retry-after')).toBeTruthy();
    expect(((await limited!.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    // Budgets are per tenant: the team workspace is unaffected.
    expect((await api(h, '/v1/workspace/usage')).status).toBe(200);
  });

  it('limits unauthenticated traffic per client IP', async () => {
    let status = 200;
    for (let i = 0; i < 70 && status !== 429; i++) status = (await fetch(`${h.baseUrl}/v1/auth/config`)).status;
    expect(status).toBe(429);
  });
});
