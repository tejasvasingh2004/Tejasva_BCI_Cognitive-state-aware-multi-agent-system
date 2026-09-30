import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().default('postgres://neuroflow:neuroflow@localhost:5433/neuroflow'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6380'),
  /** `dev` enables passwordless dev login. Production must use API keys / an identity provider. */
  AUTH_MODE: z.enum(['dev', 'production']).default('dev'),
  SESSION_SECRET: z.string().min(32).default('dev-only-session-secret-change-me-please-0123456789'),
  DEV_API_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(240),
  MAX_ACTIVE_RUNS_PER_WORKSPACE: z.coerce.number().int().positive().default(8),
  MAX_QUEUE_BACKLOG: z.coerce.number().int().positive().default(1000),
  BCI_SERVICE_URL: z.string().optional(),
  RUN_WAIT_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60_000),
});

export type ApiConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Empty values (e.g. `SESSION_SECRET=` copied from .env.example) mean "unset" so defaults apply.
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const config = Env.parse(defined);
  if (config.NODE_ENV === 'production' && config.SESSION_SECRET.startsWith('dev-only')) {
    throw new Error('SESSION_SECRET must be set in production');
  }
  return config;
}
