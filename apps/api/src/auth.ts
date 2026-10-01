import type { FastifyReply, FastifyRequest } from 'fastify';
import { ALL_SCOPES, Scopes, type Principal, type WorkspaceRole } from '@neuroflow/contracts';
import type { Redis } from '@neuroflow/bus';
import { authRepo, type Pool } from '@neuroflow/db';
import { runtimeMetrics } from '@neuroflow/observability';
import { forbidden, HttpError } from './errors';

export const SESSION_COOKIE = 'nf_session';
const SESSION_MAX_AGE_S = 7 * 24 * 3600;

type Session = { u: string; w: string; exp: number };

export const ROLE_SCOPES: Record<WorkspaceRole, string[]> = {
  owner: [...ALL_SCOPES],
  admin: [...ALL_SCOPES],
  member: ALL_SCOPES.filter((s) => s !== Scopes.admin),
  viewer: [Scopes.runsRead, Scopes.memoryRead],
};

export function sessionCookieValue(userId: string, workspaceId: string): string {
  return JSON.stringify({ u: userId, w: workspaceId, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S } satisfies Session);
}

export const sessionCookieOptions = (secure: boolean) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure,
  signed: true,
  maxAge: SESSION_MAX_AGE_S,
});

/** Thrown for presented-but-invalid credentials (counted by the auth failure limiter). */
export class InvalidCredentialsError extends HttpError {
  constructor(message = 'Invalid API key') {
    super('unauthorized', message);
  }
}

/**
 * Resolves the caller: `Authorization: Bearer <api key>` for programmatic clients, or a signed
 * session cookie for the workspace UI. Workspace membership is re-checked on every request, and a
 * key never grants more than its owner's current role allows.
 */
export async function authenticate(req: FastifyRequest, pool: Pool): Promise<Principal | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const key = header.slice(7).trim();
    const rec = key ? await authRepo.findActiveApiKey(pool, key) : null;
    if (!rec) throw new InvalidCredentialsError();
    const allowed = ROLE_SCOPES[rec.role] ?? [];
    return {
      userId: rec.userId,
      workspaceId: rec.workspaceId,
      scopes: rec.scopes.filter((s) => allowed.includes(s)),
      via: 'api_key',
      role: rec.role,
      apiKeyId: rec.id,
    };
  }

  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  let session: Session;
  try {
    session = JSON.parse(unsigned.value) as Session;
  } catch {
    return null;
  }
  if (!session.u || !session.w || session.exp < Date.now() / 1000) return null;
  const role = await authRepo.membershipRole(pool, session.u, session.w);
  if (!role) return null;
  return { userId: session.u, workspaceId: session.w, scopes: ROLE_SCOPES[role] ?? [], via: 'session', role };
}

/**
 * Brute-force protection for credentials: failed logins and invalid API keys are counted per
 * client IP in Redis. Over the limit, further attempts are rejected before any credential check.
 */
export class AuthFailureLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limit: number,
    private readonly windowS: number,
  ) {}

  private key(ip: string) {
    return `nf:authfail:${ip}`;
  }

  async assertAllowed(ip: string): Promise<void> {
    const n = Number(await this.redis.get(this.key(ip)).catch(() => 0)) || 0;
    if (n >= this.limit) {
      const ttl = await this.redis.ttl(this.key(ip)).catch(() => this.windowS);
      throw new HttpError('rate_limited', `Too many failed authentication attempts. Retry in ${Math.max(ttl, 1)}s.`, undefined, true);
    }
  }

  async recordFailure(ip: string, kind: 'api_key' | 'login'): Promise<void> {
    runtimeMetrics.authFailures.add(1, { kind });
    const key = this.key(ip);
    const n = await this.redis.incr(key).catch(() => 0);
    if (n === 1) await this.redis.expire(key, this.windowS).catch(() => {});
  }
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw new HttpError('unauthorized', 'Authentication required');
  return req.principal;
}

export function requireScope(req: FastifyRequest, scope: string): Principal {
  const p = requirePrincipal(req);
  if (!p.scopes.includes(scope)) throw forbidden(`Missing required scope "${scope}"`);
  return p;
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
