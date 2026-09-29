/**
 * E2E test stack: real API + real BullMQ worker + orchestrator + Model Gateway, backed by an
 * isolated Postgres database and Redis DB, with a deterministic mock OpenAI-compatible provider.
 * Started by Playwright's webServer; torn down on SIGTERM/SIGINT.
 */
import { Worker } from 'bullmq';
import { createRedis, RUN_QUEUE_NAME, type RunJobData } from '@neuroflow/bus';
import { createTestDatabase } from '@neuroflow/db/testing';
import { createGatewayFromEnv } from '@neuroflow/models';
import { startMockOpenAIServer } from '@neuroflow/models/testing';
import { createLogger } from '@neuroflow/observability';
import { buildApp, createDeps, loadConfig } from '@neuroflow/api';
import { createWorkerRuntime, processRun } from '@neuroflow/worker';

const PORT = Number(process.env.E2E_API_PORT ?? 8090);
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6380/2';

const flush = createRedis(REDIS_URL);
await flush.flushdb();
flush.disconnect();

const db = await createTestDatabase();
const provider = await startMockOpenAIServer();
const env = {
  DATABASE_URL: db.url,
  REDIS_URL,
  AUTH_MODE: 'dev',
  QWEN_BASE_URL: provider.url,
  QWEN_MODELS: 'qwen3:8b',
  MODEL_DEFAULT: 'qwen/qwen3:8b',
  MODEL_MAX_RETRIES: '0',
  RATE_LIMIT_PER_MINUTE: '10000',
  MAX_ACTIVE_RUNS_PER_WORKSPACE: '50',
  CORS_ORIGINS: 'http://localhost:5190',
} as NodeJS.ProcessEnv;

const logger = createLogger('e2e', { level: 'warn' });
const { deps, close } = await createDeps(loadConfig(env), logger, env);
const app = await buildApp(deps);
await app.listen({ host: '127.0.0.1', port: PORT });

const redis = createRedis(REDIS_URL);
const runtime = await createWorkerRuntime({
  pool: db.pool,
  redis,
  controlSubscriber: createRedis(REDIS_URL),
  gateway: createGatewayFromEnv(env),
  approvalTimeoutMs: 60_000,
});
const shutdown = new AbortController();
const worker = new Worker<RunJobData>(
  RUN_QUEUE_NAME,
  (job) => processRun(job.data, { pool: db.pool, redis, runtime, logger, shutdownSignal: shutdown.signal }),
  { connection: createRedis(REDIS_URL), concurrency: 4 },
);
console.log(`e2e stack ready on http://127.0.0.1:${PORT}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker.close(true).catch(() => {});
  await app.close().catch(() => {});
  await close();
  await provider.close();
  await db.drop().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
