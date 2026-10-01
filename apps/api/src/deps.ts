import type { Principal } from '@neuroflow/contracts';
import type { Pool } from '@neuroflow/db';
import type { Redis, RunControlPublisher, RunEventHub, RunQueue } from '@neuroflow/bus';
import type { CognitiveStateProvider } from '@neuroflow/cognitive';
import type { MemoryService } from '@neuroflow/memory';
import type { DefaultModelGateway } from '@neuroflow/models';
import type { Logger } from '@neuroflow/observability';
import type { ToolRegistry } from '@neuroflow/tools';
import type { WorkspaceEventHub } from '@neuroflow/bus';
import type { CodeWorkspaceService, SecretBox } from '@neuroflow/code';
import type { ApiConfig } from './config';

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
};

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}
