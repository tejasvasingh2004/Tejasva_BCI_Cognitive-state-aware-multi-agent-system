import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { ApiError } from '@neuroflow/contracts';
import { audit } from './audit';
import { AuthFailureLimiter, authenticate, InvalidCredentialsError } from './auth';
import type { AppDeps } from './deps';
import { HttpError } from './errors';
import { RunManager } from './run-manager';
import { openaiRoutes } from './routes/openai';
import { runRoutes } from './routes/runs';
import { adminRoutes } from './routes/admin';
import { codeRoutes } from './routes/code';
import { githubRoutes } from './routes/github';
import { systemRoutes } from './routes/system';
import { workspaceRoutes } from './routes/workspace';

const PUBLIC_ROUTES = new Set(['/health', '/ready', '/v1/auth/dev-login', '/v1/auth/login', '/v1/auth/logout', '/v1/auth/config']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    requestIdHeader: 'x-request-id',
    // Long-lived SSE streams must not block shutdown; clients reconnect and resume.
    forceCloseConnections: true,
    disableRequestLogging: false,
  });

  await app.register(cookie, { secret: deps.config.SESSION_SECRET });
  await app.register(cors, {
    origin: deps.config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  const authLimiter = new AuthFailureLimiter(deps.redis, deps.config.AUTH_FAILURE_LIMIT, deps.config.AUTH_FAILURE_WINDOW_S);

  // Authentication boundary: every /v1 route except explicit public ones needs a principal.
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (req.headers.authorization?.startsWith('Bearer ')) await authLimiter.assertAllowed(req.ip);
    try {
      req.principal = (await authenticate(req, deps.pool)) ?? undefined;
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        await authLimiter.recordFailure(req.ip, 'api_key');
        void audit(deps, req, { action: 'auth.api_key_rejected', outcome: 'failure', metadata: { path } });
      }
      throw err;
    }
    if (!req.principal && !PUBLIC_ROUTES.has(path) && path.startsWith('/v1/')) {
      throw new HttpError('unauthorized', 'Authentication required');
    }
  });

  await app.register(rateLimit, {
    global: true,
    hook: 'onRequest',
    max: deps.config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis: deps.redis,
    nameSpace: 'nf:rl:',
    keyGenerator: (req) => req.principal?.workspaceId ?? req.ip,
    allowList: (req) => req.url === '/health' || req.url === '/ready',
    errorResponseBuilder: (_req, ctx) =>
      new HttpError('rate_limited', `Rate limit exceeded. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`, undefined, true),
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    const body = toApiError(err);
    const status = err instanceof HttpError ? err.statusCode : body.error.code === 'bad_request' ? 400 : statusOf(err);
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } } satisfies ApiError);
  });

  const runs = new RunManager(deps);
  await app.register(async (scope) => {
    await systemRoutes(scope, deps, authLimiter);
    await adminRoutes(scope, deps);
    await runRoutes(scope, deps, runs);
    await workspaceRoutes(scope, deps, runs);
    await githubRoutes(scope, deps);
    await codeRoutes(scope, deps, runs);
    await openaiRoutes(scope, deps, runs);
  });
  return app;
}

function statusOf(err: FastifyError | Error): number {
  const code = (err as FastifyError).statusCode;
  return code && code >= 400 && code < 600 ? code : 500;
}

function toApiError(err: FastifyError | Error): ApiError {
  if (err instanceof HttpError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }
  if (err instanceof ZodError) {
    return {
      error: {
        code: 'bad_request',
        message: 'Request validation failed',
        details: err.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }
  const status = statusOf(err);
  if (status === 429) return { error: { code: 'rate_limited', message: err.message, retryable: true } };
  if (status >= 400 && status < 500) return { error: { code: 'bad_request', message: err.message } };
  // Never leak internals (stack traces, SQL, provider payloads).
  return { error: { code: 'internal', message: 'Internal server error' } };
}
