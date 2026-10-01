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
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(240),
  /** Failed logins / invalid API keys allowed per client IP per window before 429. */
  AUTH_FAILURE_LIMIT: z.coerce.number().int().positive().default(20),
  AUTH_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(600),
  MAX_ACTIVE_RUNS_PER_WORKSPACE: z.coerce.number().int().positive().default(8),
  MAX_ACTIVE_RUNS_PER_USER: z.coerce.number().int().positive().default(4),
  MAX_QUEUE_BACKLOG: z.coerce.number().int().positive().default(1000),
  BCI_SERVICE_URL: z.string().optional(),
  RUN_WAIT_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60_000),
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
    ].filter(Boolean);
    if (problems.length) throw new Error(`Invalid production configuration: ${problems.join('; ')}`);
  }
  return config;
}
