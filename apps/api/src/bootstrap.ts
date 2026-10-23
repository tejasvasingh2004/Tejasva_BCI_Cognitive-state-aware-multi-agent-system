import { BudgetService, createRedis, RedisRateLimiter, RunControlPublisher, RunEventHub, RunQueue, SpendMeter, UsageMeter, WebhookService, WorkspaceEventHub } from '@neuroflow/bus';
import { CodeWorkspaceService, createCodeTools, defaultCodeDataDir, DockerSandbox, SecretBox } from '@neuroflow/code';
import { BciHttpProvider } from '@neuroflow/cognitive';
import { createPool, keyRingFromEnv, migrate, seedDev, ProviderKeyVault } from '@neuroflow/db';
import { createMemoryTools, PgMemoryService } from '@neuroflow/memory';
import { createGatewayFromEnv } from '@neuroflow/models';
import { createErrorReporter, type Logger } from '@neuroflow/observability';
import { builtinTools, createWebSearchTool, ToolRegistry, webSearchProviderFromEnv } from '@neuroflow/tools';
import type { ApiConfig } from './config';
import type { AppDeps } from './deps';
import { PlanResolver } from './plans';

/** Creates production dependencies (connections, registries). Returns a closer for shutdown. */
export async function createDeps(config: ApiConfig, logger: Logger, env: NodeJS.ProcessEnv = process.env) {
  const pool = createPool(config.DATABASE_URL, { max: 20, applicationName: 'neuroflow-api' });
  await migrate(pool, env.MIGRATIONS_DIR);
  if (config.AUTH_MODE === 'dev') await seedDev(pool, { apiKey: config.DEV_API_KEY });

  const redis = createRedis(config.REDIS_URL);
  const subscriber = createRedis(config.REDIS_URL);
  const queue = new RunQueue(createRedis(config.REDIS_URL));
  const gateway = createGatewayFromEnv(env);
  await gateway.refreshHealth();
  const healthTimer = setInterval(() => void gateway.refreshHealth(), 30_000);
  const memory = new PgMemoryService(pool);
  const secrets = SecretBox.fromEnv(config.SECRETS_KEY, config.SESSION_SECRET);
  const code = new CodeWorkspaceService({
    pool,
    redis,
    dataDir: config.CODE_DATA_DIR ?? defaultCodeDataDir(),
    secrets,
    // The API never executes commands; the sandbox instance is only used for availability checks.
    sandbox: new DockerSandbox(),
    githubApiUrl: config.GITHUB_API_URL,
  });
  const workspaceSubscriber = createRedis(config.REDIS_URL);
  const registry = new ToolRegistry().registerAll([...builtinTools, ...createMemoryTools(memory), ...createCodeTools(code.toolServices())]);
  const search = webSearchProviderFromEnv(env);
  if (search) registry.register(createWebSearchTool(search));

  const errors = createErrorReporter({
    dsn: config.SENTRY_DSN,
    service: 'neuroflow-api',
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: config.RELEASE ?? env.RAILWAY_GIT_COMMIT_SHA ?? env.VERCEL_GIT_COMMIT_SHA ?? env.GIT_SHA,
    logger,
  });

  const deps: AppDeps = {
    config,
    logger,
    pool,
    redis,
    queue,
    hub: new RunEventHub(subscriber, pool),
    control: new RunControlPublisher(redis),
    gateway,
    tools: registry,
    memory,
    code,
    secrets,
    workspaceHub: new WorkspaceEventHub(workspaceSubscriber),
    limiter: new RedisRateLimiter(redis),
    usage: new UsageMeter(redis),
    budgets: new BudgetService(pool, new SpendMeter(redis, pool)),
    webhooks: new WebhookService(pool, secrets),
    plans: new PlanResolver(pool, config),
    errors,
    providerKeys: new ProviderKeyVault(pool, keyRingFromEnv(config, { secretsKey: config.SECRETS_KEY, fallbackSecret: config.SESSION_SECRET })),
    ...(config.BCI_SERVICE_URL ? { bci: new BciHttpProvider(config.BCI_SERVICE_URL) } : {}),
  };

  return {
    deps,
    async close() {
      clearInterval(healthTimer);
      await errors.flush();
      await queue.close().catch(() => {});
      redis.disconnect();
      subscriber.disconnect();
      workspaceSubscriber.disconnect();
      await pool.end().catch(() => {});
    },
  };
}
