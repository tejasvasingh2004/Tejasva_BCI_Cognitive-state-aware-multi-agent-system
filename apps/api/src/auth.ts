import type { FastifyReply, FastifyRequest } from 'fastify';
import { ALL_SCOPES, Scopes, type Principal } from '@neuroflow/contracts';
import { authRepo, type Pool } from '@neuroflow/db';
import { forbidden, HttpError } from './errors';

export const SESSION_COOKIE = 'nf_session';
const SESSION_MAX_AGE_S = 7 * 24 * 3600;

type Session = { u: string; w: string; exp: number };

const ROLE_SCOPES: Record<string, string[]> = {
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

/**
 * Resolves the caller: `Authorization: Bearer <api key>` for programmatic clients, or a signed
 * session cookie for the workspace UI. Workspace membership is re-checked on every request.
 */
export async function authenticate(req: FastifyRequest, pool: Pool): Promise<Principal | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const key = header.slice(7).trim();
    const rec = key ? await authRepo.findActiveApiKey(pool, key) : null;
    if (!rec) throw new HttpError('unauthorized', 'Invalid API key');
    return { userId: rec.userId, workspaceId: rec.workspaceId, scopes: rec.scopes, via: 'api_key' };
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
  return { userId: session.u, workspaceId: session.w, scopes: ROLE_SCOPES[role] ?? [], via: 'session' };
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
