import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().default('postgres://neuroflow:neuroflow@localhost:5433/neuroflow'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6380'),
  /** Concurrent runs (agent/model executions) per worker process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Concurrent repository syncs / terminal commands per worker process. */
  WORKER_WORKSPACE_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Concurrent Model Lab evaluations per worker process. */
  WORKER_EVAL_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  /** Queues served by this process: runs, workspace, evals (comma separated). */
  WORKER_QUEUES: z
    .string()
    .default('runs,workspace,evals')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(['runs', 'workspace', 'evals'])).min(1)),
  /** Overrides the plan's per-workspace running cap (operators/tests). */
  MAX_RUNNING_PER_WORKSPACE: z.coerce.number().int().positive().optional(),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  BCI_SERVICE_URL: z.string().optional(),
  TOOL_APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60_000),
  /** Code workspaces (checkouts + sandbox caches); must be the same directory as the API's. */
  CODE_DATA_DIR: z.string().optional(),
  /** Encryption key for stored credentials (base64, 32 bytes). Must match the API. */
  SECRETS_KEY: z.string().optional(),
  /** Used only to derive a development encryption key when SECRETS_KEY is unset (matches the API default). */
  SESSION_SECRET: z.string().default('dev-only-session-secret-change-me-please-0123456789'),
  GITHUB_API_URL: z.string().optional(),
  /** `disabled`: models are served only with workspaces' own provider keys (BYOK). */
  PLATFORM_MODEL_KEYS: z.enum(['enabled', 'disabled']).default('enabled'),
  /** Error tracking: a Sentry-compatible DSN. Unset = disabled. */
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  RELEASE: z.string().optional(),
  NODE_ENV: z.string().default('development'),
});

export type WorkerConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // Empty values (e.g. `SESSION_SECRET=` copied from .env.example) mean "unset" so defaults apply.
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  return Env.parse(defined);
}
