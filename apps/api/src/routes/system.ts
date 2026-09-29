import type { FastifyInstance } from 'fastify';
import { pingRedis } from '@neuroflow/bus';
import { authRepo, DEV_USER, pingDb, seedDev } from '@neuroflow/db';
import { requirePrincipal, sessionCookieOptions, sessionCookieValue, SESSION_COOKIE, clearSession } from '../auth';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../errors';

export async function systemRoutes(app: FastifyInstance, deps: AppDeps) {
  /** Liveness: the process is up. */
  app.get('/health', async () => ({ status: 'ok' }));

  /** Readiness: dependencies needed to accept work are reachable. */
  app.get('/ready', async (_req, reply) => {
    const [db, redis] = await Promise.all([pingDb(deps.pool), pingRedis(deps.redis)]);
    const models = deps.gateway.listModels();
    const body = {
      status: db && redis ? 'ready' : 'not_ready',
      checks: {
        database: db ? 'ok' : 'error',
        redis: redis ? 'ok' : 'error',
        models: models.some((m) => m.available) ? 'ok' : 'no_provider_available',
      },
    };
    return reply.code(db && redis ? 200 : 503).send(body);
  });

  app.post('/v1/auth/dev-login', async (_req, reply) => {
    if (deps.config.AUTH_MODE !== 'dev') throw notFound('Route');
    const ids = await seedDev(deps.pool);
    reply.setCookie(SESSION_COOKIE, sessionCookieValue(ids.userId, ids.workspaceId), sessionCookieOptions(deps.config.NODE_ENV === 'production'));
    return { ok: true, user: { email: DEV_USER.email } };
  });

  app.post('/v1/auth/logout', async (_req, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get('/v1/me', async (req) => {
    const p = requirePrincipal(req);
    const me = await authRepo.me(deps.pool, p.userId, p.workspaceId, p.scopes);
    if (!me) throw new HttpError('unauthorized', 'Session is no longer valid');
    return { ...me, authMode: deps.config.AUTH_MODE };
  });
}
