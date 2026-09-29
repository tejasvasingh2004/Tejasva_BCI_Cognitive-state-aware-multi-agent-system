import type {
  ApiError,
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
  WorkloadLevel,
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
};

export type RunDetails = {
  run: Run;
  details: {
    agents: Array<{ id: string; agentId: string; role: string; model: string; status: string; iterations: number; startedAt: string; completedAt: string | null; error: string | null }>;
    modelCalls: Array<{ agentExecutionId: string | null; role: string; provider: string; model: string; status: string; latencyMs: number; firstTokenMs: number | null; promptTokens: number | null; completionTokens: number | null; attempts: number; fallbackFrom: string | null; finishReason: string | null; error: string | null }>;
    toolCalls: Array<{ toolCallId: string; name: string; status: string; riskLevel: string | null; approvalStatus: string | null; errorCode: string | null; durationMs: number | null; attempts: number }>;
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
  devLogin: () => request<{ ok: true }>('/v1/auth/dev-login', { method: 'POST' }),
  logout: () => request<{ ok: true }>('/v1/auth/logout', { method: 'POST' }),

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
