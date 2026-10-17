import { randomUUID } from 'node:crypto';
import type { Redis } from './redis';

/** Per-minute budgets of one scope. Structurally identical to `BucketLimits` in @neuroflow/models. */
export type BucketLimits = { tokensPerMinute?: number; requestsPerMinute?: number };
export type Reservation = { waitMs: number; remainingTokens?: number; remainingRequests?: number };

const PREFIX = 'nf:rl:';
const BUCKET_TTL_MS = 10 * 60_000;

/*
 * Token bucket with continuous refill (capacity = per-minute limit), checked and updated in one
 * atomic script using the Redis server clock, so every API server and worker shares one budget
 * without clock skew. Returns {waitMs, remainingTokens, remainingRequests}; -1 = not limited.
 */
const RESERVE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local tpm = tonumber(ARGV[1])
local rpm = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 'tok', 'req', 'ts', 'blocked')
local blocked = tonumber(b[4] or '0')
if blocked > now then return {blocked - now, -1, -1} end
local last = tonumber(b[3] or now)
local elapsed = math.max(0, now - last)
local tok = -1
local req = -1
local wait = 0
if tpm > 0 then
  tok = math.min(tpm, tonumber(b[1] or tpm) + elapsed * tpm / 60000)
  if cost > tpm then cost = tpm end
  if tok < cost then wait = math.max(wait, math.ceil((cost - tok) * 60000 / tpm)) end
end
if rpm > 0 then
  req = math.min(rpm, tonumber(b[2] or rpm) + elapsed * rpm / 60000)
  if req < 1 then wait = math.max(wait, math.ceil((1 - req) * 60000 / rpm)) end
end
if wait == 0 then
  if tpm > 0 then tok = tok - cost end
  if rpm > 0 then req = req - 1 end
end
if tpm > 0 or rpm > 0 then
  redis.call('HSET', KEYS[1], 'tok', tostring(tok), 'req', tostring(req), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
end
return {wait, math.floor(tok), math.floor(req)}
`;

/* Correct the token bucket after the fact (may go negative = debt that delays the next caller). */
const ADJUST = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local tpm = tonumber(ARGV[1])
local delta = tonumber(ARGV[2])
local b = redis.call('HMGET', KEYS[1], 'tok', 'ts')
local last = tonumber(b[2] or now)
local tok = math.min(tpm, tonumber(b[1] or tpm) + math.max(0, now - last) * tpm / 60000)
tok = math.min(tpm, tok - delta)
redis.call('HSET', KEYS[1], 'tok', tostring(tok), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

const BLOCK = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local untilMs = now + tonumber(ARGV[1])
local current = tonumber(redis.call('HGET', KEYS[1], 'blocked') or '0')
if untilMs > current then redis.call('HSET', KEYS[1], 'blocked', tostring(untilMs)) end
redis.call('PEXPIRE', KEYS[1], math.max(tonumber(ARGV[2]), tonumber(ARGV[1]) + 1000))
return 1
`;

/*
 * Distributed semaphore: a sorted set of leases scored by expiry. Expired leases (crashed holders)
 * are dropped before counting, so a dead worker can never hold a slot forever.
 */
const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) + 1000)
  return 1
end
return 0
`;

/* Extend a lease that still exists (heartbeat of a long-running holder). */
const EXTEND = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[1]), ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) + 1000)
return 1
`;

/**
 * Redis-backed rate limiter shared by every process: model provider budgets (tokens/requests per
 * minute per API key, provider concurrency), HTTP rate limits per tenant and route, and per-tenant
 * running-job caps in the worker.
 */
export class RedisRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = PREFIX,
  ) {}

  async reserve(scope: string, limits: BucketLimits, tokens: number): Promise<Reservation> {
    const [waitMs, tok, req] = (await this.redis.eval(
      RESERVE,
      1,
      this.prefix + scope,
      String(limits.tokensPerMinute ?? 0),
      String(limits.requestsPerMinute ?? 0),
      String(Math.max(0, Math.ceil(tokens))),
      String(BUCKET_TTL_MS),
    )) as [number, number, number];
    return {
      waitMs,
      ...(tok >= 0 && limits.tokensPerMinute ? { remainingTokens: tok } : {}),
      ...(req >= 0 && limits.requestsPerMinute ? { remainingRequests: req } : {}),
    };
  }

  async adjust(scope: string, limits: BucketLimits, tokensDelta: number): Promise<void> {
    if (!limits.tokensPerMinute || tokensDelta === 0) return;
    await this.redis.eval(ADJUST, 1, this.prefix + scope, String(limits.tokensPerMinute), String(Math.round(tokensDelta)), String(BUCKET_TTL_MS));
  }

  async block(scope: string, ms: number): Promise<void> {
    if (ms <= 0) return;
    await this.redis.eval(BLOCK, 1, this.prefix + scope, String(Math.ceil(ms)), String(BUCKET_TTL_MS));
  }

  /**
   * Tries once to take a slot; returns a release function, or null when all slots are taken.
   * With `heartbeat`, the lease is renewed every ttl/3 while held, so a long job keeps its slot
   * but a crashed holder loses it within one TTL.
   */
  async tryAcquireSlot(scope: string, limit: number, ttlMs: number, opts: { heartbeat?: boolean } = {}): Promise<(() => Promise<void>) | null> {
    const key = `${this.prefix}slot:${scope}`;
    const lease = randomUUID();
    const ok = (await this.redis.eval(ACQUIRE, 1, key, String(limit), String(Math.ceil(ttlMs)), lease)) as number;
    if (!ok) return null;
    const timer = opts.heartbeat
      ? setInterval(() => void this.redis.eval(EXTEND, 1, key, String(Math.ceil(ttlMs)), lease).catch(() => {}), Math.max(1_000, Math.floor(ttlMs / 3)))
      : undefined;
    timer?.unref?.();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      await this.redis.zrem(key, lease);
    };
  }

  /** Waits (polling with backoff) until a slot is free; cancellable. */
  async acquireSlot(scope: string, limit: number, ttlMs: number, signal?: AbortSignal): Promise<() => Promise<void>> {
    let delay = 50;
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled while waiting for capacity'), { name: 'AbortError', code: 'cancelled' });
      const release = await this.tryAcquireSlot(scope, limit, ttlMs);
      if (release) return release;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay + Math.random() * delay);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      delay = Math.min(delay * 2, 1_000);
    }
  }

  /** Number of slots currently held for a scope (expired leases excluded). */
  async slotsInUse(scope: string): Promise<number> {
    const key = `${this.prefix}slot:${scope}`;
    await this.redis.zremrangebyscore(key, '-inf', Date.now());
    return this.redis.zcard(key);
  }
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Daily model-token usage per workspace (UTC days), shared by all processes. Workers add real
 * usage after each model call; the API checks it against the plan's daily quota at admission.
 * It is also the metering input for billing.
 */
export class UsageMeter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'nf:usage:tokens:',
  ) {}

  async addTokens(workspaceId: string, tokens: number, at = new Date()): Promise<void> {
    if (!(tokens > 0)) return;
    const key = `${this.prefix}${workspaceId}:${utcDay(at)}`;
    await this.redis.multi().incrby(key, Math.round(tokens)).expire(key, 3 * 24 * 3600).exec();
  }

  async tokensToday(workspaceId: string, at = new Date()): Promise<number> {
    return Number((await this.redis.get(`${this.prefix}${workspaceId}:${utcDay(at)}`)) ?? 0);
  }

  /** Next UTC midnight (when daily quotas reset). */
  static resetsAt(at = new Date()): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
  }
}
