import { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { RunEvent } from '@neuroflow/contracts';
import { createRedis, RUN_QUEUE_NAME, type Redis, type RunJobData, type WorkspaceJobData } from '@neuroflow/bus';
import { createTestDatabase } from '@neuroflow/db/testing';
import { createGatewayFromEnv } from '@neuroflow/models';
import { startMockOpenAIServer, type MockOpenAIServer } from '@neuroflow/models/testing';
import { createLogger } from '@neuroflow/observability';
import { createWorkerRuntime, processRun, processWorkspaceJob } from '@neuroflow/worker';
import { buildApp, createDeps, loadConfig } from '../../src';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/1';
export const API_KEY = 'nf_integration_test_key_000000000000';

export type Harness = {
  app: FastifyInstance;
  baseUrl: string;
  qwen: MockOpenAIServer;
  groq: MockOpenAIServer;
  db: Awaited<ReturnType<typeof createTestDatabase>>;
  shutdown: AbortController;
  worker: Worker<RunJobData | WorkspaceJobData>;
  runtime: Awaited<ReturnType<typeof createWorkerRuntime>>;
  redisUrl: string;
  restartWorker(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Full vertical slice: Fastify API + BullMQ worker + orchestrator + Model Gateway, with
 * PostgreSQL (isolated database), Redis (isolated DB index) and mock OpenAI-compatible providers.
 */
export async function startHarness(overrides: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const flush = createRedis(TEST_REDIS_URL);
  await flush.flushdb();
  flush.disconnect();

  const db = await createTestDatabase();
  const qwen = await startMockOpenAIServer();
  const groq = await startMockOpenAIServer();
  const env = {
    DATABASE_URL: db.url,
    REDIS_URL: TEST_REDIS_URL,
    DEV_API_KEY: API_KEY,
    AUTH_MODE: 'dev',
    QWEN_BASE_URL: qwen.url,
    QWEN_MODELS: 'qwen3:8b',
    GROQ_API_KEY: 'test',
    GROQ_BASE_URL: groq.url,
    GROQ_MODELS: 'llama-3.3-70b-versatile',
    MODEL_DEFAULT: 'qwen/qwen3:8b',
    MODEL_MAX_RETRIES: '1',
    MAX_ACTIVE_RUNS_PER_WORKSPACE: '50',
    RATE_LIMIT_PER_MINUTE: '10000',
    LOG_LEVEL: 'warn',
    ...overrides,
  } as NodeJS.ProcessEnv;

  const logger = createLogger('test', { level: 'warn' });
  const { deps, close: closeDeps } = await createDeps(loadConfig(env), logger, env);
  const app = await buildApp(deps);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };

  const workerRedis: Redis[] = [];
  const mk = () => {
    const r = createRedis(TEST_REDIS_URL);
    workerRedis.push(r);
    return r;
  };
  const gateway = createGatewayFromEnv(env);
  const runtime = await createWorkerRuntime({
    pool: db.pool,
    redis: mk(),
    controlSubscriber: mk(),
    gateway,
    approvalTimeoutMs: env.TOOL_APPROVAL_TIMEOUT_MS ? Number(env.TOOL_APPROVAL_TIMEOUT_MS) : 3_000,
    env,
    code: { dataDir: env.CODE_DATA_DIR, githubApiUrl: env.GITHUB_API_URL, secretsKey: env.SECRETS_KEY },
  });

  let shutdown = new AbortController();
  const newWorker = () =>
    new Worker<RunJobData | WorkspaceJobData>(
      RUN_QUEUE_NAME,
      (job) =>
        job.name === 'run'
          ? processRun(job.data as RunJobData, { pool: db.pool, redis: workerRedis[0]!, runtime, logger, shutdownSignal: shutdown.signal })
          : processWorkspaceJob(job.data as WorkspaceJobData, { runtime, redis: workerRedis[0]!, logger, signal: shutdown.signal, pool: db.pool }),
      { connection: mk(), concurrency: 4, lockDuration: 30_000 },
    );

  const harness: Harness = {
    runtime,
    redisUrl: TEST_REDIS_URL,
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    qwen,
    groq,
    db,
    shutdown,
    worker: newWorker(),
    async restartWorker() {
      await harness.worker.close(true);
      shutdown = new AbortController();
      harness.shutdown = shutdown;
      harness.worker = newWorker();
    },
    async close() {
      await harness.worker.close(true).catch(() => {});
      await app.close();
      await closeDeps();
      for (const r of workerRedis) r.disconnect();
      await qwen.close();
      await groq.close();
      await db.drop();
    },
  };
  return harness;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonResponse = Omit<Response, 'json'> & { json(): Promise<any> };

export function api(
  h: Harness,
  path: string,
  init: RequestInit & { json?: unknown; key?: string | null } = {},
): Promise<JsonResponse> {
  const headers = new Headers(init.headers);
  if (init.key !== null) headers.set('authorization', `Bearer ${init.key ?? API_KEY}`);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  return fetch(`${h.baseUrl}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
}

/** Reads an SSE stream until it ends, returning parsed `data:` payloads. */
export async function readSse(res: Pick<Response, 'body'>, onData?: (data: string) => void): Promise<string[]> {
  const out: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data) {
        out.push(data);
        onData?.(data);
      }
    }
  }
  return out;
}

export async function runEvents(h: Harness, runId: string, onEvent?: (e: RunEvent) => void): Promise<RunEvent[]> {
  const res = await api(h, `/v1/runs/${runId}/events`);
  const frames = await readSse(res, (d) => onEvent?.(JSON.parse(d) as RunEvent));
  return frames.map((f) => JSON.parse(f) as RunEvent);
}

export const text = (events: RunEvent[]) => {
  let t = '';
  for (const e of events) {
    if (e.type === 'response.delta') t += e.data.text;
    if (e.type === 'response.reset') t = '';
  }
  return t;
};
