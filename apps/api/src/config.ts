import { z } from 'zod';

const DEV_DATABASE_URL = 'postgres://neuroflow:neuroflow@localhost:5433/neuroflow';
const DEV_REDIS_URL = 'redis://127.0.0.1:6380';

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().default(DEV_DATABASE_URL),
  REDIS_URL: z.string().default(DEV_REDIS_URL),
  /**
   * `dev`: passwordless dev login + the DEV_API_KEY. `production`: email/password accounts
   * (provisioned with the db CLI) and API keys only.
   */
  AUTH_MODE: z.enum(['dev', 'production']).default('dev'),
  SESSION_SECRET: z.string().min(32).default('dev-only-session-secret-change-me-please-0123456789'),
  DEV_API_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  /** Overrides (all plans) — normally limits come from the workspace plan (packages/contracts/src/plans.ts). */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().optional(),
  RUN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().optional(),
  /** Daily model-token quota override; 0 = unlimited. */
  DAILY_TOKEN_QUOTA: z.coerce.number().int().min(0).optional(),
  /** Failed logins / invalid API keys allowed per client IP per window before 429. */
  AUTH_FAILURE_LIMIT: z.coerce.number().int().positive().default(20),
  AUTH_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(600),
  MAX_ACTIVE_RUNS_PER_WORKSPACE: z.coerce.number().int().positive().optional(),
  MAX_ACTIVE_RUNS_PER_USER: z.coerce.number().int().positive().optional(),
  MAX_QUEUE_BACKLOG: z.coerce.number().int().positive().default(1000),
  BCI_SERVICE_URL: z.string().optional(),
  RUN_WAIT_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60_000),
  // ---- Product Phase 2: code workspaces & GitHub ----
  /** Code workspaces (checkouts + sandbox caches); must be the same directory as the worker's. */
  CODE_DATA_DIR: z.string().optional(),
  /** Encryption key for stored credentials (base64, 32 bytes): `openssl rand -base64 32`. */
  SECRETS_KEY: z.string().optional(),
  GITHUB_API_URL: z.string().optional(),
  /** OAuth App (optional): enables "Connect with GitHub". Token connections work without it. */
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  GITHUB_OAUTH_URL: z.string().default('https://github.com'),
  /** Public URL of the web app (OAuth redirects). Defaults to the first CORS origin. */
  PUBLIC_WEB_URL: z.string().optional(),
  /** `disabled`: models are served only with workspaces' own provider keys (BYOK). */
  PLATFORM_MODEL_KEYS: z.enum(['enabled', 'disabled']).default('enabled'),
  /** Key-encryption key for workspace provider keys: local (SECRETS_KEY), aws-kms or vault. Same on API and worker. */
  KEK_PROVIDER: z.enum(['local', 'aws-kms', 'vault']).default('local'),
  AWS_KMS_KEY_ID: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_KMS_ENDPOINT: z.string().optional(),
  VAULT_ADDR: z.string().optional(),
  VAULT_TOKEN: z.string().optional(),
  VAULT_TRANSIT_KEY: z.string().optional(),
  VAULT_TRANSIT_MOUNT: z.string().optional(),
  VAULT_NAMESPACE: z.string().optional(),
  // ---- Operations ----
  /** Error tracking: a Sentry-compatible DSN. Unset = disabled. */
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  /** Release reported with errors (defaults to the commit the platform deployed). */
  RELEASE: z.string().optional(),
  /** /status reports "degraded" when a job has waited longer than this to start. */
  STATUS_MAX_QUEUE_AGE_S: z.coerce.number().int().positive().default(300),
});

export type ApiConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Empty values (e.g. `SESSION_SECRET=` copied from .env.example) mean "unset" so defaults apply.
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const config = Env.parse(defined);
  if (config.NODE_ENV === 'production') {
    // Never run production on development credentials or defaults.
    const problems = [
      config.SESSION_SECRET.startsWith('dev-only') && 'SESSION_SECRET must be set',
      !defined.DATABASE_URL && 'DATABASE_URL must be set explicitly',
      !defined.REDIS_URL && 'REDIS_URL must be set explicitly',
      config.DATABASE_URL.includes('neuroflow:neuroflow@') && 'DATABASE_URL uses the development password',
      config.AUTH_MODE !== 'production' && 'AUTH_MODE must be "production"',
      config.DEV_API_KEY && 'DEV_API_KEY must not be set in production',
      !config.SECRETS_KEY && 'SECRETS_KEY must be set (encrypts stored GitHub credentials)',
    ].filter(Boolean);
    if (problems.length) throw new Error(`Invalid production configuration: ${problems.join('; ')}`);
  }
  return config;
}
