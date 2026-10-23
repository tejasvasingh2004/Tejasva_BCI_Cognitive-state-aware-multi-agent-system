import { createErrorReporter, initTelemetry, reportProcessErrors, shutdownTelemetry, createLogger } from '@neuroflow/observability';

// Telemetry must start before instrumented libraries (pg, ioredis, http) are imported.
await initTelemetry('neuroflow-worker');

const { createRedis, RunQueue, RedisRateLimiter, startWorkerHeartbeat, WebhookDeliverer } = await import('@neuroflow/bus');
const { createPool, keyRingFromEnv, migrate } = await import('@neuroflow/db');
const { createGatewayFromEnv } = await import('@neuroflow/models');
const { loadConfig } = await import('./config');
const { createWorkerRuntime } = await import('./runtime');
const { purgeExpiredMemories, reconcileRuns } = await import('./reconciler');
const { startQueueWorkers } = await import('./workers');

const logger = createLogger('neuroflow-worker');
const config = loadConfig();
const errors = createErrorReporter({
  dsn: config.SENTRY_DSN,
  service: 'neuroflow-worker',
  environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
  release: config.RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA,
  logger,
});
reportProcessErrors(errors, logger);

const pool = createPool(config.DATABASE_URL, { max: config.WORKER_CONCURRENCY * 2 + 2, applicationName: 'neuroflow-worker' });
await migrate(pool, process.env.MIGRATIONS_DIR);

const redis = createRedis(config.REDIS_URL);
const controlSubscriber = createRedis(config.REDIS_URL);
const bullConnections: ReturnType<typeof createRedis>[] = [];
const queue = new RunQueue(createRedis(config.REDIS_URL));

// Provider budgets live in Redis so they hold across every worker process.
const gateway = createGatewayFromEnv(process.env, { limiter: new RedisRateLimiter(redis) });
const health = await gateway.refreshHealth();
logger.info({ providers: health, models: gateway.listModels().map((m) => `${m.ref}${m.available ? '' : ' (unavailable)'}`) }, 'model gateway ready');
const healthTimer = setInterval(() => void gateway.refreshHealth(), 30_000);

const runtime = await createWorkerRuntime({
  pool,
  redis,
  controlSubscriber,
  gateway,
  bciServiceUrl: config.BCI_SERVICE_URL,
  platformKeys: config.PLATFORM_MODEL_KEYS === 'enabled',
  keyRing: keyRingFromEnv(config, { secretsKey: config.SECRETS_KEY, fallbackSecret: config.SESSION_SECRET }),
  ...(config.ROUTER_LEARNING === 'enabled' ? { learnedRouting: { exploration: config.ROUTER_EXPLORATION, minSamples: config.ROUTER_MIN_SAMPLES } } : {}),
  approvalTimeoutMs: config.TOOL_APPROVAL_TIMEOUT_MS,
  code: { dataDir: config.CODE_DATA_DIR, secretsKey: config.SECRETS_KEY, sessionSecret: config.SESSION_SECRET, githubApiUrl: config.GITHUB_API_URL },
  onToolError: (err, info) => logger.warn({ err, ...info }, 'tool failed unexpectedly'),
});

const shutdown = new AbortController();
// One worker per queue (bulkheads); WORKER_QUEUES lets a process serve a subset (e.g. eval-only nodes).
const workers = startQueueWorkers({
  pool,
  redis,
  connection: () => {
    const c = createRedis(config.REDIS_URL);
    bullConnections.push(c);
    return c;
  },
  runtime,
  logger,
  shutdownSignal: shutdown.signal,
  queues: config.WORKER_QUEUES,
  concurrency: { runs: config.WORKER_CONCURRENCY, workspace: config.WORKER_WORKSPACE_CONCURRENCY, evals: config.WORKER_EVAL_CONCURRENCY },
  ...(config.MAX_RUNNING_PER_WORKSPACE ? { maxRunningPerWorkspace: config.MAX_RUNNING_PER_WORKSPACE } : {}),
  errors,
});
// Liveness for the API's /status: disappears within ~30 s if this process dies or hangs.
const heartbeat = startWorkerHeartbeat(redis, { queues: workers.queues });
// Webhook deliveries (Postgres outbox; every worker can deliver, rows are claimed with SKIP LOCKED).
const deliverer = new WebhookDeliverer(pool, runtime.webhooks, {
  allowPrivate: config.WEBHOOK_ALLOW_PRIVATE,
  onError: (err) => logger.warn({ err }, 'webhook delivery pass failed'),
});
deliverer.start();

const reconcileTimer = setInterval(() => {
  void reconcileRuns({ pool, redis, queue, logger, webhooks: runtime.webhooks }).catch((err) => logger.error({ err }, 'reconcile failed'));
  void purgeExpiredMemories({ pool, memory: runtime.memory, logger }).catch((err) => logger.error({ err }, 'memory purge failed'));
}, config.RECONCILE_INTERVAL_MS);

logger.info({ queues: workers.queues, concurrency: config.WORKER_CONCURRENCY }, 'worker started');

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down: finishing active runs');
  clearInterval(reconcileTimer);
  clearInterval(healthTimer);
  // Stop taking new jobs, give active runs a grace period, then interrupt them so they are
  // retried elsewhere instead of being left half-finished.
  const graceful = workers.close();
  const timer = setTimeout(() => {
    logger.warn('grace period elapsed; interrupting active runs for retry');
    shutdown.abort();
  }, config.WORKER_SHUTDOWN_TIMEOUT_MS);
  await graceful.catch(() => {});
  clearTimeout(timer);
  await heartbeat.stop();
  await deliverer.stop();
  await errors.flush();
  await Promise.allSettled([queue.close(), pool.end()]);
  for (const r of [redis, controlSubscriber, ...bullConnections]) r.disconnect();
  await shutdownTelemetry();
  logger.info('worker stopped');
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
