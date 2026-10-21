import { hostname } from 'node:os';
import type { Redis } from 'ioredis';

const PREFIX = 'nf:worker:';

export type WorkerInfo = {
  id: string;
  host: string;
  pid: number;
  queues: string[];
  startedAt: string;
  /** Last heartbeat. */
  at: string;
};

/**
 * Each worker process refreshes a key with a short TTL. A worker that crashes, hangs or loses
 * Redis disappears within one TTL, so "no live workers" is detectable by the API's /status.
 * (BullMQ's own worker listing relies on CLIENT LIST, which some managed Redis services block.)
 */
export function startWorkerHeartbeat(redis: Redis, opts: { queues: string[]; intervalMs?: number; ttlMs?: number }): { id: string; stop(): Promise<void> } {
  const intervalMs = opts.intervalMs ?? 10_000;
  const ttlMs = opts.ttlMs ?? intervalMs * 3;
  const id = `${hostname()}-${process.pid}`;
  const startedAt = new Date().toISOString();
  const beat = () =>
    redis
      .set(`${PREFIX}${id}`, JSON.stringify({ id, host: hostname(), pid: process.pid, queues: opts.queues, startedAt, at: new Date().toISOString() } satisfies WorkerInfo), 'PX', ttlMs)
      .catch(() => {});
  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref?.();
  return {
    id,
    async stop() {
      clearInterval(timer);
      await redis.del(`${PREFIX}${id}`).catch(() => {});
    },
  };
}

/** Workers whose heartbeat has not expired. */
export async function liveWorkers(redis: Redis): Promise<WorkerInfo[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < 1000);
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  return values.flatMap((v) => {
    try {
      return v ? [JSON.parse(v) as WorkerInfo] : [];
    } catch {
      return [];
    }
  });
}
