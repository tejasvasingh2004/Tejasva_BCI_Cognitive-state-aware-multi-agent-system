import type {
  AgentSpec,
  ApiError,
  ApiKeyInfo,
  AuditEvent,
  CreatedApiKey,
  CreateProviderKeyBody,
  ProviderKeyInfo,
  ProviderKeysResponse,
  WorkspaceSettings,
  CognitivePolicy,
  CognitiveState,
  Conversation,
  ConversationDetail,
  CreateRunResponse,
  Me,
  MemoryItem,
  RunRequestInput,
  Run,
  ToolDescriptor,
  UsageHistory,
  WorkloadLevel,
  WorkspaceUsage,
} from '@neuroflow/contracts';

/** All server communication goes through the NeuroFlow API — never directly to model providers. */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (body as ApiError | null)?.error;
    throw new ApiRequestError(res.status, err?.code ?? 'internal', err?.message ?? `Request failed (${res.status})`, err?.retryable);
  }
  return body as T;
}

export type ModelOption = {
  id: string;
  display_name: string;
  owned_by: string;
  tier?: string;
  available: boolean;
  capabilities?: { tools: boolean; reasoning: boolean };
  pricing?: { inputPerMTok: number; outputPerMTok: number };
};

export type RunDetails = {
  run: Run;
  details: {
    agents: Array<{ id: string; agentId: string; role: string; model: string; status: string; iterations: number; startedAt: string; completedAt: string | null; error: string | null }>;
    modelCalls: Array<{ agentExecutionId: string | null; role: string; provider: string; model: string; status: string; latencyMs: number; firstTokenMs: number | null; promptTokens: number | null; completionTokens: number | null; attempts: number; fallbackFrom: string | null; finishReason: string | null; error: string | null; costUsd: number | null; createdAt: string }>;
    toolCalls: Array<{ toolCallId: string; name: string; status: string; riskLevel: string | null; approvalStatus: string | null; errorCode: string | null; durationMs: number | null; attempts: number; agentExecutionId: string | null; createdAt: string }>;
    evaluations: Array<{ kind: string; iteration: number; verdict: string; score: number | null; issues: string[] }>;
  };
};

export type CognitiveInfo = {
  state: (CognitiveState & { provider: string }) | null;
  policy: CognitivePolicy | null;
  bciAvailable: boolean;
};

export const api = {
  me: () => request<Me & { authMode: 'dev' | 'production' }>('/v1/me'),
  authConfig: () => request<{ authMode: 'dev' | 'production' }>('/v1/auth/config'),
  devLogin: () => request<{ ok: true }>('/v1/auth/dev-login', { method: 'POST' }),
  login: (email: string, password: string) => request<{ ok: true }>('/v1/auth/login', { method: 'POST', json: { email, password } }),
  logout: () => request<{ ok: true }>('/v1/auth/logout', { method: 'POST' }),

  apiKeys: () => request<{ apiKeys: ApiKeyInfo[] }>('/v1/api-keys'),
  createApiKey: (name: string, scopes?: string[]) =>
    request<{ apiKey: CreatedApiKey }>('/v1/api-keys', { method: 'POST', json: { name, ...(scopes ? { scopes } : {}) } }),
  revokeApiKey: (id: string) => request<void>(`/v1/api-keys/${id}`, { method: 'DELETE' }),

  usage: () => request<WorkspaceUsage>('/v1/workspace/usage'),
  providerKeys: () => request<ProviderKeysResponse>('/v1/provider-keys'),
  createProviderKey: (body: CreateProviderKeyBody) => request<{ key: ProviderKeyInfo }>('/v1/provider-keys', { method: 'POST', json: body }),
  verifyProviderKey: (id: string) => request<{ key: ProviderKeyInfo }>(`/v1/provider-keys/${id}/verify`, { method: 'POST' }),
  deleteProviderKey: (id: string) => request<void>(`/v1/provider-keys/${id}`, { method: 'DELETE' }),
  usageHistory: (days: number) => request<UsageHistory>(`/v1/workspace/usage/history?days=${days}`),

  settings: () => request<{ settings: WorkspaceSettings; canEdit: boolean }>('/v1/workspace/settings'),
  updateSettings: (patch: Partial<WorkspaceSettings>) =>
    request<{ settings: WorkspaceSettings; canEdit: boolean }>('/v1/workspace/settings', { method: 'PATCH', json: patch }),

  agents: () => request<{ agents: AgentSpec[]; canEdit: boolean }>('/v1/agents'),
  saveAgent: (agent: Omit<AgentSpec, 'builtin'>) =>
    request<{ agent: AgentSpec }>(`/v1/agents/${agent.id}`, { method: 'PUT', json: agent }),
  deleteAgent: (id: string) => request<void>(`/v1/agents/${id}`, { method: 'DELETE' }),

  audit: (before?: string) => request<{ events: AuditEvent[] }>(`/v1/audit?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`),

  models: () => request<{ data: ModelOption[]; default: string | null }>('/v1/models'),
  tools: () => request<{ tools: ToolDescriptor[] }>('/v1/tools'),

  conversations: () => request<{ conversations: Conversation[] }>('/v1/conversations'),
  conversation: (id: string) => request<ConversationDetail>(`/v1/conversations/${id}`),
  createConversation: () => request<{ conversation: Conversation }>('/v1/conversations', { method: 'POST', json: {} }),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: Conversation }>(`/v1/conversations/${id}`, { method: 'PATCH', json: { title } }),
  deleteConversation: (id: string) => request<void>(`/v1/conversations/${id}`, { method: 'DELETE' }),

  startRun: (conversationId: string, body: Omit<RunRequestInput, 'conversationId'>, idempotencyKey: string) =>
    request<CreateRunResponse>(`/v1/conversations/${conversationId}/runs`, {
      method: 'POST',
      json: body,
      headers: { 'idempotency-key': idempotencyKey },
    }),
  run: (id: string) => request<RunDetails>(`/v1/runs/${id}`),
  cancelRun: (id: string) => request<{ run: Run }>(`/v1/runs/${id}/cancel`, { method: 'POST' }),
  approve: (runId: string, toolCallId: string, approved: boolean) =>
    request<{ ok: true }>(`/v1/runs/${runId}/approvals`, { method: 'POST', json: { toolCallId, approved } }),

  memories: () => request<{ memories: MemoryItem[] }>('/v1/memories'),
  addMemory: (content: string, tags: string[] = []) =>
    request<{ memory: MemoryItem }>('/v1/memories', { method: 'POST', json: { content, tags } }),
  deleteMemory: (id: string) => request<void>(`/v1/memories/${id}`, { method: 'DELETE' }),

  cognitive: () => request<CognitiveInfo>('/v1/cognitive/state'),
  setWorkload: (workload: WorkloadLevel) =>
    request<CognitiveInfo>('/v1/cognitive/state', { method: 'PUT', json: { workload, source: 'manual', confidence: 1 } }),
  sampleBci: () => request<CognitiveInfo>('/v1/cognitive/sample', { method: 'POST' }),
};
