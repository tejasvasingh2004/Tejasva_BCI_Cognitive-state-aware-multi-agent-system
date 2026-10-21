import { createLogger, initTelemetry, reportProcessErrors, shutdownTelemetry } from '@neuroflow/observability';

// Telemetry must start before instrumented libraries (http, fastify, pg, ioredis) are imported.
await initTelemetry('neuroflow-api');

const { createDeps } = await import('./bootstrap');
const { buildApp } = await import('./app');
const { loadConfig } = await import('./config');

const config = loadConfig();
const logger = createLogger('neuroflow-api');
const { deps, close } = await createDeps(config, logger);
reportProcessErrors(deps.errors, logger);
const app = await buildApp(deps);

await app.listen({ host: config.HOST, port: config.PORT });

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down API');
  await app.close().catch(() => {});
  await close();
  await shutdownTelemetry();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
