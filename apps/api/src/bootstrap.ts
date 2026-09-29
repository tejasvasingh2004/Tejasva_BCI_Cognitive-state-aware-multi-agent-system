import { createRedis, RunControlPublisher, RunEventHub, RunQueue } from '@neuroflow/bus';
import { BciHttpProvider } from '@neuroflow/cognitive';
import { createPool, migrate, seedDev } from '@neuroflow/db';
import { createMemoryTools, PgMemoryService } from '@neuroflow/memory';
import { createGatewayFromEnv } from '@neuroflow/models';
import type { Logger } from '@neuroflow/observability';
import { builtinTools, ToolRegistry } from '@neuroflow/tools';
import type { ApiConfig } from './config';
import type { AppDeps } from './deps';

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

  const deps: AppDeps = {
    config,
    logger,
    pool,
    redis,
    queue,
    hub: new RunEventHub(subscriber, pool),
    control: new RunControlPublisher(redis),
    gateway,
    tools: new ToolRegistry().registerAll([...builtinTools, ...createMemoryTools(memory)]),
    memory,
    ...(config.BCI_SERVICE_URL ? { bci: new BciHttpProvider(config.BCI_SERVICE_URL) } : {}),
  };

  return {
    deps,
    async close() {
      clearInterval(healthTimer);
      await queue.close().catch(() => {});
      redis.disconnect();
      subscriber.disconnect();
      await pool.end().catch(() => {});
    },
  };
}
