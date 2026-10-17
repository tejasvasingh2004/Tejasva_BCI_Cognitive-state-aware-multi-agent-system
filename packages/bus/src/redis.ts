import { Redis, type RedisOptions } from 'ioredis';

export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6380';

/** Creates a Redis connection. BullMQ requires `maxRetriesPerRequest: null` on worker connections. */
export function createRedis(url = process.env.REDIS_URL ?? DEFAULT_REDIS_URL, opts: RedisOptions = {}): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...opts,
  });
  // Connection errors are retried by ioredis; avoid unhandled 'error' events crashing the process.
  redis.on('error', () => {});
  return redis;
}

export async function pingRedis(redis: Redis): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export const keys = {
  events: (runId: string) => `nf:run:${runId}:events`,
  control: (runId: string) => `nf:run:${runId}:control`,
  controlPattern: 'nf:run:*:control',
  approval: (runId: string, toolCallId: string) => `nf:run:${runId}:approval:${toolCallId}`,
};

export type { Redis };
