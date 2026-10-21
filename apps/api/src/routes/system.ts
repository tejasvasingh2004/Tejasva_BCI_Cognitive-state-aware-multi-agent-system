import type { FastifyInstance } from 'fastify';
import { liveWorkers, pingRedis } from '@neuroflow/bus';
import { authRepo, DEV_USER, pingDb, seedDev } from '@neuroflow/db';
import { LoginBody } from '@neuroflow/contracts';
import { audit } from '../audit';
import {
  clearSession,
  requirePrincipal,
  sessionCookieOptions,
  sessionCookieValue,
  SESSION_COOKIE,
  type AuthFailureLimiter,
} from '../auth';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../errors';

export async function systemRoutes(app: FastifyInstance, deps: AppDeps, authLimiter: AuthFailureLimiter) {
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

  /**
   * Public health summary for uptime monitors and alerts: 200 when the system can serve work end
   * to end, 503 when it cannot (database or Redis down, no live worker, a queue stuck, or no model
   * provider). Only aggregate counts — no tenant data.
   */
  app.get('/status', async (_req, reply) => {
    const [db, redis] = await Promise.all([pingDb(deps.pool), pingRedis(deps.redis)]);
    const problems: string[] = [];
    if (!db) problems.push('database unreachable');
    if (!redis) problems.push('redis unreachable');
    let workers: number | null = null;
    let queues: Record<string, { waiting: number; active: number; oldestWaitingSeconds: number | null }> | null = null;
    if (redis) {
      const [alive, stats, ages] = await Promise.all([liveWorkers(deps.redis), deps.queue.stats(), deps.queue.oldestWaitingAgeMs()]);
      workers = alive.length;
      if (workers === 0) problems.push('no live worker');
      queues = Object.fromEntries(
        Object.entries(stats).map(([kind, s]) => {
          const age = ages[kind as keyof typeof ages];
          const oldestWaitingSeconds = age === null ? null : Math.round(age / 1000);
          if (oldestWaitingSeconds !== null && oldestWaitingSeconds > deps.config.STATUS_MAX_QUEUE_AGE_S) {
            problems.push(`${kind} queue: oldest job waiting ${oldestWaitingSeconds}s`);
          }
          return [kind, { ...s, oldestWaitingSeconds }];
        }),
      );
    }
    const modelsAvailable = deps.gateway.listModels().some((m) => m.available);
    if (!modelsAvailable) problems.push('no model provider available');
    const status = !db || !redis ? 'down' : problems.length ? 'degraded' : 'ok';
    return reply
      .code(status === 'ok' ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({ status, time: new Date().toISOString(), problems, checks: { database: db ? 'ok' : 'error', redis: redis ? 'ok' : 'error', workers, queues, models: modelsAvailable ? 'ok' : 'none_available' } });
  });

  /** Public: tells the web app which sign-in experience to show. */
  app.get('/v1/auth/config', async () => ({ authMode: deps.config.AUTH_MODE }));

  /** Email + password sign-in for accounts provisioned with the db CLI (both auth modes). */
  app.post('/v1/auth/login', async (req, reply) => {
    await authLimiter.assertAllowed(req.ip);
    const { email, password } = LoginBody.parse(req.body);
    const ids = await authRepo.verifyLogin(deps.pool, email, password);
    if (!ids) {
      await authLimiter.recordFailure(req.ip, 'login');
      // The email is recorded so repeated targeting of an account is visible; never the password.
      void audit(deps, req, { action: 'auth.login_failed', outcome: 'failure', metadata: { email: email.toLowerCase() } });
      throw new HttpError('unauthorized', 'Incorrect email or password');
    }
    reply.setCookie(SESSION_COOKIE, sessionCookieValue(ids.userId, ids.workspaceId), sessionCookieOptions(deps.config.NODE_ENV === 'production'));
    void audit(deps, null, { action: 'auth.login', workspaceId: ids.workspaceId, actorUserId: ids.userId, actorVia: 'password', ip: req.ip });
    return { ok: true };
  });

  app.post('/v1/auth/dev-login', async (_req, reply) => {
    if (deps.config.AUTH_MODE !== 'dev') throw notFound('Route');
    const ids = await seedDev(deps.pool);
    reply.setCookie(SESSION_COOKIE, sessionCookieValue(ids.userId, ids.workspaceId), sessionCookieOptions(deps.config.NODE_ENV === 'production'));
    return { ok: true, user: { email: DEV_USER.email } };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    if (req.principal) void audit(deps, req, { action: 'auth.logout' });
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
