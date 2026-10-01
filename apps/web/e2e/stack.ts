/**
 * E2E test stack: real API + real BullMQ worker + orchestrator + Model Gateway, backed by an
 * isolated Postgres database and Redis DB, with a deterministic mock OpenAI-compatible provider.
 * Started by Playwright's webServer; torn down on SIGTERM/SIGINT.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'bullmq';
import { createRedis, RUN_QUEUE_NAME, type RunJobData, type WorkspaceJobData } from '@neuroflow/bus';
import { createFixtureRepo, startMockGitHub } from '@neuroflow/code/testing';
import { createTestDatabase } from '@neuroflow/db/testing';
import { createGatewayFromEnv } from '@neuroflow/models';
import { defaultScript, startMockOpenAIServer, textReply, toolCallReply, type MockScript } from '@neuroflow/models/testing';
import { createLogger } from '@neuroflow/observability';
import { buildApp, createDeps, loadConfig } from '@neuroflow/api';
import { createWorkerRuntime, processRun, processWorkspaceJob } from '@neuroflow/worker';

const PORT = Number(process.env.E2E_API_PORT ?? 8090);
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6380/2';

const flush = createRedis(REDIS_URL);
await flush.flushdb();
flush.disconnect();

const db = await createTestDatabase();

// ---- Product Phase 2: a real Git repository behind a mock GitHub API ----
const fixture = await createFixtureRepo({
  'package.json': JSON.stringify({ name: 'calc', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/math.js': 'export function add(a, b) {\n  return a - b;\n}\n',
  'test/math.test.js':
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  'README.md': '# calc\n',
});
const ghRepo = {
  id: 1,
  name: 'calc',
  full_name: 'acme/calc',
  owner: { login: 'acme' },
  private: true,
  default_branch: 'main',
  clone_url: fixture.remote,
  html_url: 'https://github.test/acme/calc',
  description: 'Tiny calculator',
  updated_at: new Date().toISOString(),
  permissions: { admin: false, push: true, pull: true },
};
const github = await startMockGitHub(({ method, path: p, body }) => {
  if (p === '/user') return { body: { login: 'octo', id: 42, name: 'Octo', avatar_url: '' } };
  if (p === '/user/orgs') return { body: [{ login: 'acme', avatar_url: '' }] };
  if (p === '/orgs/acme/repos' || p === '/user/repos') return { body: [ghRepo] };
  if (p === '/repos/acme/calc') return { body: ghRepo };
  if (p === '/repos/acme/calc/branches') return { body: [{ name: 'main', commit: { sha: 'abc' }, protected: true }] };
  if (p.startsWith('/repos/acme/calc/branches/')) return { body: { name: decodeURIComponent(p.split('/branches/')[1]!), commit: { sha: 'abc' }, protected: false } };
  if (p === '/repos/acme/calc/pulls' && method === 'POST') {
    const b = body as { title: string; head: string; base: string };
    return { status: 201, body: { number: 12, title: b.title, state: 'open', html_url: 'https://github.test/acme/calc/pull/12', head: { ref: b.head }, base: { ref: b.base }, user: { login: 'octo' }, draft: true } };
  }
  return undefined;
});
const codeDir = await mkdtemp(path.join(os.tmpdir(), 'nf-e2e-code-'));

/** Deterministic Code Agent: plan → read src/math.js → edit (held for review) → answer. */
const script: MockScript = (body, callIndex) => {
  const toolNames = new Set((body.tools ?? []).map((t) => t.function.name));
  const system = String(body.messages.find((m) => m.role === 'system')?.content ?? '');
  if (body.response_format && system.includes('You plan a coding task')) {
    return textReply(JSON.stringify({ steps: ['Read src/math.js', 'Fix add()', 'Run the tests'], summary: 'add() subtracts instead of adding.' }));
  }
  if (!toolNames.has('read_file')) return defaultScript(body, callIndex);
  const last = body.messages.at(-1)!;
  if (last.role === 'tool' && String(last.content).includes('return a - b')) {
    return toolCallReply('edit_file', { path: 'src/math.js', edits: [{ find: 'return a - b;', replace: 'return a + b;' }], summary: 'Use addition in add()' }, 'edit-' + Date.now());
  }
  if (last.role === 'tool') return textReply('Fixed **add()** in src/math.js: it now returns a + b.', { chunkDelayMs: 5 });
  return toolCallReply('read_file', { path: 'src/math.js' }, 'read-' + Date.now());
};
const provider = await startMockOpenAIServer(script);
// A second provider so multi-model routing can be exercised end to end.
const provider2 = await startMockOpenAIServer();
const env = {
  DATABASE_URL: db.url,
  REDIS_URL,
  AUTH_MODE: 'dev',
  QWEN_BASE_URL: provider.url,
  QWEN_MODELS: 'qwen3:8b',
  GROQ_API_KEY: 'e2e',
  GROQ_BASE_URL: provider2.url,
  GROQ_MODELS: 'llama-3.3-70b-versatile',
  MODEL_DEFAULT: 'qwen/qwen3:8b',
  MODEL_MAX_RETRIES: '0',
  RATE_LIMIT_PER_MINUTE: '10000',
  MAX_ACTIVE_RUNS_PER_WORKSPACE: '50',
  CORS_ORIGINS: 'http://localhost:5190',
  CODE_DATA_DIR: codeDir,
  GITHUB_API_URL: github.url,
  SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
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
  approvalTimeoutMs: 120_000,
  env,
  code: { dataDir: codeDir, githubApiUrl: github.url, secretsKey: env.SECRETS_KEY },
});
const shutdown = new AbortController();
const worker = new Worker<RunJobData | WorkspaceJobData>(
  RUN_QUEUE_NAME,
  (job) =>
    job.name === 'run'
      ? processRun(job.data as RunJobData, { pool: db.pool, redis, runtime, logger, shutdownSignal: shutdown.signal })
      : processWorkspaceJob(job.data as WorkspaceJobData, { runtime, redis, logger, signal: shutdown.signal, pool: db.pool }),
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
  await provider2.close();
  await github.close();
  await fixture.cleanup();
  await rm(codeDir, { recursive: true, force: true }).catch(() => {});
  await db.drop().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
