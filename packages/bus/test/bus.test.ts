import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunRequest, type RunEvent } from '@neuroflow/contracts';
import { conversationsRepo, runsRepo, seedDev } from '@neuroflow/db';
import { createTestDatabase, isPostgresReachable } from '@neuroflow/db/testing';
import {
  createRedis,
  pingRedis,
  RunControlListener,
  RunControlPublisher,
  RunEventEmitter,
  RunEventHub,
  RunQueue,
  type Redis,
} from '../src';

// Isolated Redis DB so tests never interact with a locally running worker.
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/3';
const redisProbe = createRedis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
const reachable = (await isPostgresReachable()) && (await redisProbe.connect().then(() => pingRedis(redisProbe), () => false));
redisProbe.disconnect();

describe.skipIf(!reachable)('bus (Redis + Postgres)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let redis: Redis;
  let sub: Redis;
  let sub2: Redis;
  let ids: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    redis = createRedis(TEST_REDIS_URL);
    sub = createRedis(TEST_REDIS_URL);
    sub2 = createRedis(TEST_REDIS_URL);
    ids = await seedDev(db.pool);
  });
  afterAll(async () => {
    redis.disconnect();
    sub.disconnect();
    sub2.disconnect();
    await db.drop();
  });

  async function newRun() {
    const conv = await conversationsRepo.create(db.pool, ids);
    const { run } = await runsRepo.create(db.pool, {
      ...ids,
      conversationId: conv.id,
      request: RunRequest.parse({ messages: [{ role: 'user', content: 'x' }] }),
      source: 'workspace',
      scopes: [],
    });
    return run;
  }

  it('replays history then follows live events without gaps or duplicates', async () => {
    const run = await newRun();
    const emitter = new RunEventEmitter({ db: db.pool, redis, runId: run.id, startSeq: 0, deltaFlushMs: 10 });
    emitter.emit('run.created', { mode: 'standard' });
    emitter.emit('run.queued', {});
    await emitter.flush();

    const hub = new RunEventHub(sub, db.pool);
    const received: RunEvent[] = [];
    const done = new Promise<void>((resolve) => {
      void hub.follow(run.id, 0, (e) => {
        received.push(e);
        if (e.type === 'run.completed') resolve();
      });
    });

    emitter.emit('run.started', { attempt: 1, queueLatencyMs: 3 });
    for (const t of ['Hel', 'lo ', 'wor', 'ld']) emitter.emit('response.delta', { text: t });
    emitter.emit('run.completed', { durationMs: 10 });
    await emitter.flush();
    await done;

    const seqs = received.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(received[0]!.type).toBe('run.created');
    const text = received
      .filter((e): e is Extract<RunEvent, { type: 'response.delta' }> => e.type === 'response.delta')
      .map((e) => e.data.text)
      .join('');
    expect(text).toBe('Hello world');
    // Deltas are coalesced into fewer events.
    expect(received.filter((e) => e.type === 'response.delta').length).toBeLessThan(4);
  });

  it('resumes from a Last-Event-ID style sequence', async () => {
    const run = await newRun();
    const emitter = new RunEventEmitter({ db: db.pool, redis, runId: run.id, startSeq: 0 });
    emitter.emit('run.created', { mode: 'standard' });
    emitter.emit('run.queued', {});
    emitter.emit('run.completed', { durationMs: 1 });
    await emitter.flush();
    const hub = new RunEventHub(sub, db.pool);
    const got: number[] = [];
    const stop = await hub.follow(run.id, 2, (e) => got.push(e.seq));
    await stop();
    expect(got).toEqual([3]);
  });

  it('delivers approvals, including decisions made before the worker waits', async () => {
    const listener = new RunControlListener(sub2, redis);
    await listener.start();
    const publisher = new RunControlPublisher(redis);
    const ac = new AbortController();

    await publisher.approval('run-a', 'tc-early', true);
    await expect(listener.waitForApproval('run-a', 'tc-early', 2000, ac.signal)).resolves.toMatchObject({
      approved: true,
    });

    const waiting = listener.waitForApproval('run-a', 'tc-late', 2000, ac.signal);
    setTimeout(() => void publisher.approval('run-a', 'tc-late', false, 'no'), 50);
    await expect(waiting).resolves.toMatchObject({ approved: false, reason: 'no' });

    await expect(listener.waitForApproval('run-a', 'tc-none', 100, ac.signal)).resolves.toBe('timeout');

    const cancelled = new Promise<string>((resolve) => listener.on('run-b', (m) => resolve(m.type)));
    await publisher.cancel('run-b');
    await expect(cancelled).resolves.toBe('cancel');
  });

  it('enqueues runs idempotently by run id', async () => {
    const q = new RunQueue(redis);
    const runId = crypto.randomUUID();
    await q.enqueue({ runId, workspaceId: ids.workspaceId });
    await q.enqueue({ runId, workspaceId: ids.workspaceId });
    expect(await q.backlog()).toBeGreaterThanOrEqual(1);
    expect(await q.removeIfWaiting(runId)).toBe(true);
    expect(await q.isActive(runId)).toBe(false);
    await q.close();
  });
});
