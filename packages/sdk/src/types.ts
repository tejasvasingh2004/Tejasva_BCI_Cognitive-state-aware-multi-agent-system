/**
 * Public API types. They mirror the server's contracts; the SDK has no runtime dependencies, so
 * they are declared here (a compile-time test keeps them assignable from the server's types).
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage = {
  role: Role;
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
};

export type ReasoningBudget = 'off' | 'low' | 'medium' | 'high';
export type RunMode = 'standard' | 'cognitive';
export type AgentStrategy = 'auto' | 'direct' | 'single_agent' | 'sequential' | 'parallel' | 'supervisor' | 'evaluator_optimizer';
export type ModelStrategy = 'auto' | 'single' | 'multi';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Estimated USD cost, when every model involved has a known price. */
  costUsd?: number;
};

export type RunError = { code: string; message: string; stage?: string };

/** Body of `POST /v1/runs`. Only `messages` is required. */
export type RunRequest = {
  messages: ChatMessage[];
  conversationId?: string;
  mode?: RunMode;
  /** `<provider>/<model>`, e.g. `anthropic/claude-sonnet-5-5`; omitted = the router chooses. */
  selectedModel?: string;
  modelStrategy?: ModelStrategy;
  agentStrategy?: AgentStrategy;
  /** Restrict the tools this run may use. */
  tools?: string[];
  reasoningBudget?: ReasoningBudget;
  temperature?: number;
  maxOutputTokens?: number;
  agent?: string;
  responseFormat?: 'text' | 'json' | { type: 'json_schema'; name?: string; schema: Record<string, unknown> };
  /** Per-run caps: estimated cost (USD) and wall time. */
  budget?: { maxCostUsd?: number; maxDurationMs?: number };
  metadata?: Record<string, unknown>;
  /** Async runs: a signed `run.*` webhook is posted here when the run ends or needs approval. */
  webhookUrl?: string;
  [key: string]: unknown;
};

export type Run = {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  mode: RunMode;
  status: RunStatus;
  request: Omit<RunRequest, 'messages'>;
  executionPlan: unknown;
  output: string | null;
  error: RunError | null;
  usage: Usage | null;
  toolCalls: ToolCall[] | null;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
};

export type CreateRunResponse = { run: Run; conversationId: string; eventsUrl: string };

/** Data of the events most clients act on; every other event type arrives with `data: unknown`. */
export type KnownRunEventData = {
  'run.created': { mode: RunMode };
  'run.queued': Record<string, never>;
  'run.started': Record<string, unknown>;
  'response.delta': { text: string };
  'response.reset': { reason: string };
  'approval.requested': {
    toolCallId: string;
    name: string;
    riskLevel: string;
    arguments: unknown;
    expiresAt: string;
    reason?: string;
    preview?: unknown;
  };
  'approval.resolved': { toolCallId: string; approved: boolean; reason?: string };
  'run.completed': { durationMs: number; usage?: Usage; toolCalls?: ToolCall[] };
  'run.failed': { error: RunError };
  'run.cancelled': { reason: string };
};

export type RunEvent =
  | { [T in keyof KnownRunEventData]: { runId: string; seq: number; ts: string; type: T; data: KnownRunEventData[T] } }[keyof KnownRunEventData]
  | { runId: string; seq: number; ts: string; type: string & {}; data: unknown };

export type ApprovalRequest = KnownRunEventData['approval.requested'] & { runId: string };
export type ApprovalDecision = { toolCallId: string; approved: boolean; reason?: string };

export const TERMINAL_EVENTS = ['run.completed', 'run.failed', 'run.cancelled'] as const;

export type WebhookEventType =
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.approval_requested'
  | 'budget.threshold_reached'
  | 'budget.exceeded'
  | 'webhook.test';

export type WebhookEvent = {
  id: string;
  type: WebhookEventType;
  timestamp: string;
  workspaceId: string;
  data: Record<string, unknown>;
};
