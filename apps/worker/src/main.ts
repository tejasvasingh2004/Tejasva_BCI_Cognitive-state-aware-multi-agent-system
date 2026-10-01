import { initTelemetry, shutdownTelemetry, createLogger } from '@neuroflow/observability';

// Telemetry must start before instrumented libraries (pg, ioredis, http) are imported.
await initTelemetry('neuroflow-worker');

const { Worker } = await import('bullmq');
const { createRedis, RUN_QUEUE_NAME, RunQueue } = await import('@neuroflow/bus');
const { createPool, migrate } = await import('@neuroflow/db');
const { createGatewayFromEnv } = await import('@neuroflow/models');
const { loadConfig } = await import('./config');
const { createWorkerRuntime } = await import('./runtime');
const { processRun, WorkerShutdownError } = await import('./processor');
const { purgeExpiredMemories, reconcileRuns } = await import('./reconciler');

const logger = createLogger('neuroflow-worker');
const config = loadConfig();

const pool = createPool(config.DATABASE_URL, { max: config.WORKER_CONCURRENCY * 2 + 2, applicationName: 'neuroflow-worker' });
await migrate(pool, process.env.MIGRATIONS_DIR);

const redis = createRedis(config.REDIS_URL);
const controlSubscriber = createRedis(config.REDIS_URL);
const bullConnection = createRedis(config.REDIS_URL);
const queue = new RunQueue(createRedis(config.REDIS_URL));

const gateway = createGatewayFromEnv();
const health = await gateway.refreshHealth();
logger.info({ providers: health, models: gateway.listModels().map((m) => `${m.ref}${m.available ? '' : ' (unavailable)'}`) }, 'model gateway ready');
const healthTimer = setInterval(() => void gateway.refreshHealth(), 30_000);

const runtime = await createWorkerRuntime({
  pool,
  redis,
  controlSubscriber,
  gateway,
  bciServiceUrl: config.BCI_SERVICE_URL,
  approvalTimeoutMs: config.TOOL_APPROVAL_TIMEOUT_MS,
});

const shutdown = new AbortController();
const worker = new Worker(
  RUN_QUEUE_NAME,
  (job) => processRun(job.data, { pool, redis, runtime, logger, shutdownSignal: shutdown.signal }),
  {
    connection: bullConnection,
    concurrency: config.WORKER_CONCURRENCY,
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  },
);
worker.on('failed', (job, err) => {
  if (err instanceof WorkerShutdownError) return;
  logger.error({ runId: job?.id, err }, 'run job failed (infrastructure error)');
});
worker.on('error', (err) => logger.error({ err }, 'worker error'));

const reconcileTimer = setInterval(() => {
  void reconcileRuns({ pool, redis, queue, logger }).catch((err) => logger.error({ err }, 'reconcile failed'));
  void purgeExpiredMemories({ pool, memory: runtime.memory, logger }).catch((err) => logger.error({ err }, 'memory purge failed'));
}, config.RECONCILE_INTERVAL_MS);

logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker started');

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down: finishing active runs');
  clearInterval(reconcileTimer);
  clearInterval(healthTimer);
  // Stop taking new jobs, give active runs a grace period, then interrupt them so they are
  // retried elsewhere instead of being left half-finished.
  const graceful = worker.close();
  const timer = setTimeout(() => {
    logger.warn('grace period elapsed; interrupting active runs for retry');
    shutdown.abort();
  }, config.WORKER_SHUTDOWN_TIMEOUT_MS);
  await graceful.catch(() => {});
  clearTimeout(timer);
  await Promise.allSettled([queue.close(), pool.end()]);
  for (const r of [redis, controlSubscriber, bullConnection]) r.disconnect();
  await shutdownTelemetry();
  logger.info('worker stopped');
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
