import type {
  ChatMessage,
  ExecutionPlan,
  ModelRole,
  RunMode,
  RunRequest,
  ToolCall,
  Usage,
} from '@neuroflow/contracts';
import type { CognitiveStateProvider } from '@neuroflow/cognitive';
import type { ModelGateway } from '@neuroflow/models';
import type { EmitFn, ToolRuntime, ApprovalGate } from '@neuroflow/tools';
import type { AgentDefinition } from './agents/definitions';
import type { CodeContext } from './context';

/** Persistence port. The worker implements it with PostgreSQL; tests use an in-memory version. */
export interface RunStore {
  setPlan(runId: string, plan: ExecutionPlan): Promise<void>;
  startAgent(input: { runId: string; agentId: string; role: string; model: string }): Promise<string>;
  finishAgent(
    id: string,
    input: { status: 'completed' | 'failed' | 'cancelled'; iterations: number; output?: string; error?: string },
  ): Promise<void>;
  recordModelCall(input: {
    runId: string;
    /** Tenant of the run (usage metering). */
    workspaceId?: string;
    agentExecutionId?: string;
    role: string;
    provider: string;
    model: string;
    status: 'completed' | 'failed' | 'cancelled';
    latencyMs: number;
    firstTokenMs?: number;
    usage?: Usage;
    attempts: number;
    fallbackFrom?: string;
    finishReason?: string;
    error?: string;
  }): Promise<void>;
  recordEvaluation(input: {
    runId: string;
    kind: string;
    iteration: number;
    verdict: 'passed' | 'failed' | 'needs_refinement';
    score?: number;
    issues: string[];
  }): Promise<void>;
}

export type OrchestratorDeps = {
  gateway: ModelGateway;
  tools: ToolRuntime;
  store: RunStore;
  cognitive?: CognitiveStateProvider;
  /** Workspace-defined agents merged over the built-ins (static, e.g. tests). */
  agents?: AgentDefinition[];
  /** Loads the workspace's custom agents for each run. */
  loadAgents?: (workspaceId: string) => Promise<AgentDefinition[]>;
  /** Human decisions outside tool calls (Plan Review). Without it, plans are never held. */
  approvals?: ApprovalGate;
  planReviewTimeoutMs?: number;
};

export type RunIdentity = {
  id: string;
  workspaceId: string;
  userId: string;
  conversationId: string | null;
  mode: RunMode;
};

export type ExecuteRunInput = {
  run: RunIdentity;
  request: Omit<RunRequest, 'messages'>;
  /** Full conversation, oldest first, ending with the new user message(s). */
  history: ChatMessage[];
  scopes: readonly string[];
  signal: AbortSignal;
  emit: EmitFn;
  /**
   * The gateway view for this run, e.g. scoped to the tenant's own provider keys (BYOK). Routing,
   * defaults and every model call of the run use it; defaults to the orchestrator's gateway.
   */
  gateway?: ModelGateway;
  /** Additional bounded context sources. */
  context?: {
    workspaceInstructions?: string;
    /** Rolling summary of conversation turns older than `history`. */
    conversationSummary?: string;
    /** Repository context of a code run. */
    code?: CodeContext;
  };
};

export type RunOutcome = {
  output: string;
  usage?: Usage;
  plan: ExecutionPlan;
  /** Client-defined tool calls the run ended with (returned to the API client). */
  toolCalls?: ToolCall[];
};

export type ModelAssignmentLookup = (role: ModelRole) => { model: string; fallbacks: string[] };
