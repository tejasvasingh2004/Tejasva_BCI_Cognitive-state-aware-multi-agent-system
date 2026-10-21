import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedis, startWorkerHeartbeat } from '@neuroflow/bus';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { api, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();

type Status = {
  status: 'ok' | 'degraded' | 'down';
  problems: string[];
  checks: { database: string; redis: string; workers: number | null; models: string; queues: Record<string, { waiting: number; active: number; oldestWaitingSeconds: number | null }> | null };
};

/** /status is what uptime monitors poll: 200 only when work can flow end to end. */
describe.skipIf(!reachable)('status endpoint', () => {
  let h: Harness;
  const status = async () => {
    const res = await api(h, '/status', { key: null });
    return { code: res.status, body: (await res.json()) as Status, cache: res.headers.get('cache-control') };
  };

  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('is public and reports degraded (503) when no worker is alive', async () => {
    const { code, body, cache } = await status();
    expect(code).toBe(503);
    expect(cache).toBe('no-store');
    expect(body.status).toBe('degraded');
    expect(body.problems).toContain('no live worker');
    expect(body.checks).toMatchObject({ database: 'ok', redis: 'ok', workers: 0, models: 'ok' });
    expect(Object.keys(body.checks.queues ?? {})).toEqual(['runs', 'workspace', 'evals']);
  });

  it('turns ok while a worker heartbeat is live, and degraded again when it stops', async () => {
    const redis = createRedis(h.redisUrl);
    const heartbeat = startWorkerHeartbeat(redis, { queues: ['runs', 'workspace', 'evals'] });
    try {
      let s = await status();
      for (let i = 0; i < 20 && s.code !== 200; i++) {
        await new Promise((r) => setTimeout(r, 100));
        s = await status();
      }
      expect(s.code).toBe(200);
      expect(s.body).toMatchObject({ status: 'ok', problems: [] });
      expect(s.body.checks.workers).toBeGreaterThanOrEqual(1);
      expect(s.body.checks.queues!.runs).toMatchObject({ waiting: 0, oldestWaitingSeconds: null });
    } finally {
      await heartbeat.stop();
      redis.disconnect();
    }
    const after = await status();
    expect(after.code).toBe(503);
    expect(after.body.problems).toContain('no live worker');
  });
});
