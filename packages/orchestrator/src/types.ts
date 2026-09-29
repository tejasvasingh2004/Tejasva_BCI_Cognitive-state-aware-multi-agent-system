import type {
  ChatMessage,
  ExecutionPlan,
  ModelRole,
  RunMode,
  RunRequest,
  Usage,
} from '@neuroflow/contracts';
import type { CognitiveStateProvider } from '@neuroflow/cognitive';
import type { ModelGateway } from '@neuroflow/models';
import type { EmitFn, ToolRuntime } from '@neuroflow/tools';

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
  /** Workspace-defined agents merged over the built-ins. */
  agents?: import('./agents/definitions').AgentDefinition[];
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
};

export type RunOutcome = {
  output: string;
  usage?: Usage;
  plan: ExecutionPlan;
};

export type ModelAssignmentLookup = (role: ModelRole) => { model: string; fallbacks: string[] };
