import { z } from 'zod';
import { ChatMessage } from './messages';
import { Run } from './runs';

export const Conversation = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof Conversation>;

export const StoredMessage = ChatMessage.extend({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type StoredMessage = z.infer<typeof StoredMessage>;

export const ConversationDetail = z.object({
  conversation: Conversation,
  messages: z.array(StoredMessage),
  runs: z.array(Run),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

export const CreateConversationBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const UpdateConversationBody = z.object({
  title: z.string().trim().min(1).max(200),
});

export const MemoryItem = z.object({
  id: z.string().uuid(),
  content: z.string(),
  tags: z.array(z.string()),
  source: z.string(),
  createdAt: z.string(),
  /** Set when the memory expires under the workspace retention policy (or its own TTL). */
  expiresAt: z.string().nullable().optional(),
  score: z.number().optional(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

export const CreateMemoryBody = z.object({
  content: z.string().trim().min(1).max(4000),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /** Optional time-to-live in days; otherwise the workspace retention policy applies. */
  ttlDays: z.number().int().min(1).max(3650).optional(),
});

export const SearchMemoryBody = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
});

export const Principal = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  scopes: z.array(z.string()),
  via: z.enum(['session', 'api_key']),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  apiKeyId: z.string().uuid().optional(),
});
export type Principal = z.infer<typeof Principal>;

export const WorkspaceRole = z.enum(['owner', 'admin', 'member', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const Me = z.object({
  user: z.object({ id: z.string().uuid(), email: z.string(), displayName: z.string() }),
  workspace: z.object({ id: z.string().uuid(), name: z.string() }),
  role: WorkspaceRole.optional(),
  scopes: z.array(z.string()),
});
export type Me = z.infer<typeof Me>;

/** Scopes checked by the API and the tool runtime. */
export const Scopes = {
  runsWrite: 'runs:write',
  runsRead: 'runs:read',
  memoryRead: 'memory:read',
  memoryWrite: 'memory:write',
  toolsExecute: 'tools:execute',
  /** Browse repositories, read code, search (Product Phase 2). */
  codeRead: 'code:read',
  /** Edit files, run sandboxed commands, local Git operations. */
  codeWrite: 'code:write',
  /** Push branches, open pull requests / issues on GitHub. */
  codePublish: 'code:publish',
  admin: 'admin',
} as const;
export const ALL_SCOPES = Object.values(Scopes);

// ---- authentication ----

export const LoginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(512),
});
export type LoginBody = z.infer<typeof LoginBody>;

/** Minimum password policy for locally managed accounts. */
export const PASSWORD_MIN_LENGTH = 12;

// ---- API keys ----

export const ApiKeyInfo = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKeyInfo = z.infer<typeof ApiKeyInfo>;

export const CreateApiKeyBody = z.object({
  name: z.string().trim().min(1).max(100),
  /** Defaults to the caller's own scopes; can only narrow them. */
  scopes: z.array(z.string()).max(16).optional(),
});

/** Returned once on creation: the plaintext key is never retrievable again. */
export const CreatedApiKey = ApiKeyInfo.extend({ key: z.string() });
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;

// ---- workspace settings ----

export const WorkspaceSettings = z.object({
  /** Workspace-level instructions included in every run's context (bounded). */
  instructions: z.string().max(4000),
  /** Memories expire after this many days; null keeps them until deleted. */
  memoryRetentionDays: z.number().int().min(1).max(3650).nullable(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const UpdateWorkspaceSettingsBody = WorkspaceSettings.partial();

// ---- custom agents ----

export const AgentOutputContract = z.object({
  format: z.enum(['markdown', 'text', 'json']),
  description: z.string().max(1000).optional(),
});
export type AgentOutputContract = z.infer<typeof AgentOutputContract>;

export const AgentSpec = z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,64}$/, 'lowercase letters, digits, - and _ only'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(8000),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(16).default([]),
  /** Tool names the agent may use (intersected with the run's tool policy). */
  tools: z.array(z.string()).max(32).default([]),
  modelRole: z.enum(['agent', 'research', 'analysis', 'synthesis']).default('agent'),
  maxIterations: z.number().int().min(1).max(10).default(4),
  outputContract: AgentOutputContract.optional(),
  builtin: z.boolean().optional(),
});
export type AgentSpec = z.infer<typeof AgentSpec>;
export const UpsertAgentBody = AgentSpec.omit({ builtin: true });

// ---- audit ----

export const AuditAction = z.enum([
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.api_key_rejected',
  'api_key.created',
  'api_key.revoked',
  'run.created',
  'run.cancelled',
  'tool.approval_decided',
  'memory.created',
  'memory.deleted',
  'memory.expired',
  'cognitive.state_set',
  'workspace.settings_updated',
  'agent.upserted',
  'agent.deleted',
  'github.connected',
  'github.disconnected',
  'code.workspace_created',
  'code.file_saved',
  'code.command_run',
  'code.commit',
  'code.push',
  'code.pull_request',
  'code.patch_decided',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEvent = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  actorUserId: z.string().uuid().nullable(),
  actorVia: z.string().nullable(),
  action: AuditAction,
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  outcome: z.enum(['success', 'failure']),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
