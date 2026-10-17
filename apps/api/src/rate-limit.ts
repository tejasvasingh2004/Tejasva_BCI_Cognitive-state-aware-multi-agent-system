import type { FastifyReply, FastifyRequest } from 'fastify';
import { ANONYMOUS_REQUESTS_PER_MINUTE, type PlanLimits } from '@neuroflow/contracts';
import type { RedisRateLimiter } from '@neuroflow/bus';
import { HttpError } from './errors';
import type { PlanResolver } from './plans';

export type RouteClass = 'runs' | 'commands' | 'default';

const RUN_ROUTES = [/^\/v1\/runs$/, /^\/v1\/code\/runs$/, /^\/v1\/chat\/completions$/, /^\/v1\/conversations\/[^/]+\/runs$/];
const COMMAND_ROUTES = [/^\/v1\/code\/workspaces\/[^/]+\/commands$/];
const UNLIMITED = new Set(['/health', '/ready']);

/** Expensive endpoints get their own (smaller) budget on top of the general one. */
export function routeClass(method: string, path: string): RouteClass {
  if (method !== 'POST') return 'default';
  if (RUN_ROUTES.some((r) => r.test(path))) return 'runs';
  if (COMMAND_ROUTES.some((r) => r.test(path))) return 'commands';
  return 'default';
}

function perMinute(limits: PlanLimits, cls: RouteClass): number {
  return cls === 'runs' ? limits.runsPerMinute : cls === 'commands' ? limits.commandsPerMinute : limits.requestsPerMinute;
}

/**
 * Distributed token-bucket rate limiting per tenant and route class (shared by every API server
 * through Redis). Every response carries `RateLimit-Limit`/`RateLimit-Remaining`; a rejected
 * request gets 429 with `Retry-After`. Unauthenticated traffic is limited per client IP.
 */
export function httpRateLimiter(deps: { limiter: RedisRateLimiter; plans: PlanResolver }) {
  return async function rateLimit(req: FastifyRequest, reply: FastifyReply) {
    const path = req.url.split('?')[0]!;
    if (UNLIMITED.has(path)) return;
    const cls = routeClass(req.method, path);
    const checks: Array<{ scope: string; limit: number }> = [];
    if (req.principal) {
      const { limits } = await deps.plans.limits(req.principal.workspaceId);
      const ws = req.principal.workspaceId;
      checks.push({ scope: `http:default:${ws}`, limit: limits.requestsPerMinute });
      if (cls !== 'default') checks.push({ scope: `http:${cls}:${ws}`, limit: perMinute(limits, cls) });
    } else {
      checks.push({ scope: `http:anon:${req.ip}`, limit: ANONYMOUS_REQUESTS_PER_MINUTE });
    }
    // The most specific budget is reported in the headers.
    const reported = checks.at(-1)!;
    for (const check of checks) {
      const r = await deps.limiter.reserve(check.scope, { requestsPerMinute: check.limit }, 0);
      if (check === reported) {
        void reply.header('ratelimit-limit', check.limit);
        void reply.header('ratelimit-remaining', Math.max(0, r.remainingRequests ?? 0));
      }
      if (r.waitMs > 0) {
        const what = check.scope.startsWith('http:runs') ? 'new runs' : check.scope.startsWith('http:commands') ? 'sandbox commands' : 'requests';
        throw new HttpError('rate_limited', `Rate limit exceeded for ${what}. Retry in ${Math.ceil(r.waitMs / 1000)}s.`, undefined, true, {
          retryAfterMs: r.waitMs,
        });
      }
    }
  };
}
