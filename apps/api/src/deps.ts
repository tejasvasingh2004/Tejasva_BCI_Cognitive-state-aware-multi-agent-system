import type { Principal } from '@neuroflow/contracts';
import type { Pool, ProviderKeyVault } from '@neuroflow/db';
import type { BudgetService, Redis, RedisRateLimiter, ResponseCache, RunControlPublisher, RunEventHub, RunQueue, UsageMeter, WebhookService } from '@neuroflow/bus';
import type { WorkspaceGateways } from './gateway-mode';
import type { CognitiveStateProvider } from '@neuroflow/cognitive';
import type { MemoryService } from '@neuroflow/memory';
import type { DefaultModelGateway } from '@neuroflow/models';
import type { ErrorReporter, Logger } from '@neuroflow/observability';
import type { ToolRegistry } from '@neuroflow/tools';
import type { WorkspaceEventHub } from '@neuroflow/bus';
import type { CodeWorkspaceService, SecretBox } from '@neuroflow/code';
import type { ApiConfig } from './config';
import type { PlanResolver } from './plans';

/** Everything the HTTP layer needs. The API never calls model providers for runs. */
export type AppDeps = {
  config: ApiConfig;
  logger: Logger;
  pool: Pool;
  redis: Redis;
  queue: RunQueue;
  hub: RunEventHub;
  control: RunControlPublisher;
  /** Used for model listing/health only; execution happens in workers. */
  gateway: DefaultModelGateway;
  tools: ToolRegistry;
  memory: MemoryService;
  bci?: CognitiveStateProvider;
  /** Code workspaces (Product Phase 2). File/git reads happen here; commands only in the worker sandbox. */
  code: CodeWorkspaceService;
  workspaceHub: WorkspaceEventHub;
  secrets: SecretBox;
  /** Shared (Redis) token buckets: HTTP rate limits per tenant and route. */
  limiter: RedisRateLimiter;
  /** Daily model-token usage per workspace. */
  usage: UsageMeter;
  /** Dollar budgets: workspace limits are checked when a run is admitted (workers check every call). */
  budgets: BudgetService;
  /** Webhook endpoints, signing secret and outbox (workers deliver). */
  webhooks: WebhookService;
  /** Gateway mode: per-workspace gateway views (workspace keys + budget guard). */
  gateways: WorkspaceGateways;
  /** Gateway mode: opt-in exact-match answer cache per workspace. */
  responseCache: ResponseCache;
  plans: PlanResolver;
  /** Unexpected errors (5xx, crashes) → error tracking; a no-op unless SENTRY_DSN is set. */
  errors: ErrorReporter;
  /** Workspaces' own provider keys (BYOK), envelope-encrypted. The API stores and checks them; only workers decrypt them for runs. */
  providerKeys: ProviderKeyVault;
};

/** The model catalogue as one workspace sees it: its own keys, plus platform keys when enabled. */
export async function modelScope(deps: Pick<AppDeps, 'providerKeys' | 'config'>, workspaceId: string) {
  return { credentialProviders: await deps.providerKeys.activeProviders(workspaceId), platformKeys: deps.config.PLATFORM_MODEL_KEYS === 'enabled' };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}
