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
  /** Learned routing: choose models from measured quality, cost and latency per task class. */
  /** Sandbox isolation runtime: runsc (gVisor), kata-fc / kata-qemu (microVMs); unset = Docker default. */
  SANDBOX_RUNTIME: z.string().optional(),
  ROUTER_LEARNING: z.enum(['enabled', 'disabled']).default('enabled'),
  /** Share of eligible runs routed to an under-sampled model to keep learning (0 disables). */
  ROUTER_EXPLORATION: z.coerce.number().min(0).max(0.5).default(0.05),
  ROUTER_MIN_SAMPLES: z.coerce.number().int().positive().default(20),
  /** Code workspaces (checkouts + sandbox caches); must be the same directory as the API's. */
  CODE_DATA_DIR: z.string().optional(),
  /** Encryption key for stored credentials (base64, 32 bytes). Must match the API. */
  SECRETS_KEY: z.string().optional(),
  /** Used only to derive a development encryption key when SECRETS_KEY is unset (matches the API default). */
  SESSION_SECRET: z.string().default('dev-only-session-secret-change-me-please-0123456789'),
  GITHUB_API_URL: z.string().optional(),
  /** `disabled`: models are served only with workspaces' own provider keys (BYOK). */
  PLATFORM_MODEL_KEYS: z.enum(['enabled', 'disabled']).default('enabled'),
  /** Key-encryption key for workspace provider keys: local (SECRETS_KEY), aws-kms, vault or gcp-kms. Same on API and worker. */
  /** Webhooks may target http and private/loopback addresses: local development and tests only. */
  WEBHOOK_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  KEK_PROVIDER: z.enum(['local', 'aws-kms', 'vault', 'gcp-kms']).default('local'),
  GCP_KMS_KEY_NAME: z.string().optional(),
  GCP_KMS_ENDPOINT: z.string().optional(),
  GCP_KMS_CREDENTIALS_JSON: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  AWS_KMS_KEY_ID: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_KMS_ENDPOINT: z.string().optional(),
  VAULT_ADDR: z.string().optional(),
  VAULT_TOKEN: z.string().optional(),
  VAULT_TRANSIT_KEY: z.string().optional(),
  VAULT_TRANSIT_MOUNT: z.string().optional(),
  VAULT_NAMESPACE: z.string().optional(),
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
