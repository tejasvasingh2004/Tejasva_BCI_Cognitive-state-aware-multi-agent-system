# NeuroFlow — System Design
Version 6 — Phase 1 + Phase 2 Aligned

> Source of truth: `prd.md`. This document translates both product phases into implementation-level contracts.

## 0. Product Phase Model

NeuroFlow has two **product phases**, while the implementation checklist may use additional internal workstreams. Do not confuse the two.

### Product Phase 1 — Core NeuroFlow AI Runtime

The complete general runtime: conversations, Runs, routing, agents, models, tools, memory, evaluation, realtime, cancellation, reliability, Standard/Cognitive Mode, persistence and observability.

### Product Phase 2 — AI Code Agent / AI IDE Workspace

A specialized coding workspace that reuses Product Phase 1's Run Manager, Orchestrator, Agent Runtime, Model Gateway, Tool Runtime, Context Engine, Memory, Evaluation, realtime events, authorization and observability.

Phase 2-specific additions are domain contracts around repositories, branches, code context, patches, sandbox execution, Git/GitHub, Code Agent runs, replay and Model Lab.

## 1. Runtime Components

```text
apps/
  web/                 React + Vite frontend
  api/                 Fastify HTTP/WebSocket API
  worker/              BullMQ worker runtime

packages/
  contracts/           shared TypeScript schemas/types
  orchestrator/        AI execution runtime
  agents/              agent definitions/strategies
  models/              model gateway
  tools/               tool runtime
  memory/              memory engine
  cognitive/           cognitive runtime
  context/              context engine
  evaluation/          evaluator
  observability/       telemetry
  ui/                  shared frontend components
```

A monorepo is recommended.

Suggested tooling:

```text
pnpm workspaces
Turborepo
TypeScript
ESLint
Prettier
Vitest
Playwright
```

---

## 2. API Request Model

Conceptual request:

```ts
type RunRequest = {
  conversationId?: string;
  messages: Message[];
  mode?: "standard" | "cognitive";

  modelStrategy?: "single" | "multi" | "auto";
  selectedModel?: string;

  agentStrategy?:
    | "single"
    | "sequential"
    | "parallel"
    | "supervisor"
    | "evaluator_optimizer"
    | "auto";

  tools?: ToolReference[];
  stream?: boolean;
  metadata?: Record<string, unknown>;

  // Optional Phase 2 context; absent for ordinary Phase 1 runs.
  workspaceContext?: {
    workspaceId?: string;
    repositoryId?: string;
    branch?: string;
    activeFile?: string;
    selectedLines?: { start: number; end: number };
    relatedFiles?: string[];
  };
};
```

The external OpenAI-compatible endpoint may accept OpenAI-style request shapes, but internally NeuroFlow converts them to a normalized RunRequest.

---

## 3. Request Lifecycle

```text
HTTP request
 ↓
Fastify route
 ↓
Authentication
 ↓
Zod validation
 ↓
Prompt/context limits
 ↓
Create Run
 ↓
Persist run metadata
 ↓
Queue job
 ↓
Return run/stream handle
```

Do not execute long-running model/tool loops directly inside the API handler.

---

## 4. Queue and Worker

BullMQ is the initial queue implementation.

Job:

```ts
type RunJob = {
  runId: string;
  workspaceId: string;
  priority: number;
};
```

Worker:

```text
BullMQ Worker
   ↓
load run
   ↓
resolve policy
   ↓
run orchestrator
   ↓
emit events
   ↓
persist checkpoints
   ↓
complete/fail/cancel
```

---

## 5. Adaptive Router

The router produces:

```ts
type ExecutionPlan = {
  mode: "standard" | "cognitive";
  taskClass: string;

  agentStrategy:
    | "direct"
    | "single"
    | "sequential"
    | "parallel"
    | "supervisor"
    | "evaluator_optimizer";

  modelStrategy: "single" | "multi";

  toolPolicy: ToolPolicy;
  contextPolicy: ContextPolicy;

  reasoningBudget: "off" | "low" | "medium" | "high";
};
```

Routing should consider:

- task complexity
- required capabilities
- tool availability
- latency budget
- cost budget
- reliability
- selected model
- cognitive policy when enabled

The router should not automatically choose maximum complexity.

---

## 6. Model Gateway

Interface:

```ts
interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

Provider adapters:

```text
ModelGateway
 ├── QwenAdapter
 ├── GroqAdapter
 └── future providers
```

The rest of NeuroFlow must not depend directly on provider SDK details.

The gateway handles:

- provider selection
- model selection
- retries
- timeout
- fallback
- reasoning budget translation
- streaming normalization
- usage metadata

---

## 7. Tool Contract

Canonical tool contract:

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
};
```

Execution:

```text
Model
 ↓
ToolCall
 ↓
ToolRegistry lookup
 ↓
Zod / JSON Schema validation
 ↓
Authorization
 ↓
Approval if required
 ↓
Execution
 ↓
Timeout
 ↓
Normalized ToolResult
 ↓
Model continuation
```

---

## 8. Tool Result

```ts
type ToolResult = {
  toolCallId: string;
  name: string;
  status: "success" | "error" | "timeout" | "denied";
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  durationMs: number;
};
```

Tool output must be bounded before being placed into model context.

---

## 9. Agent Runtime

Agents are execution roles, not necessarily separate models.

```ts
type AgentDefinition = {
  id: string;
  name: string;
  instructions: string;
  capabilities: string[];
  tools: string[];
  modelPolicy?: ModelPolicy;
};
```

Possible topology:

```text
                 Supervisor
                /    |     \
               /     |      \
          Research  Build  Evaluate
```

or:

```text
Research → Draft → Evaluate → Refine
```

or:

```text
Research ─┐
Analysis ─┼→ Synthesis
Tools ────┘
```

---

## 10. Context Engine

Context assembly should be deterministic and inspectable.

```text
ContextBuilder
 ├── system instructions
 ├── current task
 ├── recent messages
 ├── summary
 ├── workspace context
 ├── retrieved memories
 ├── tool results
 ├── execution state
 └── cognitive context
```

Context policies should enforce:

- maximum tokens
- priority
- truncation
- summarization
- deduplication
- source metadata

---

## 11. Memory Service

Suggested initial abstraction:

```ts
interface MemoryService {
  search(input: MemorySearchInput): Promise<MemoryItem[]>;
  store(input: MemoryStoreInput): Promise<MemoryItem>;
}
```

Possible future storage:

```text
PostgreSQL
+
pgvector
```

Memory should not automatically be injected into every request.

---

## 12. Cognitive Runtime

```ts
interface CognitiveStateProvider {
  getState(sessionId: string): Promise<CognitiveState>;
}
```

The Cognitive Policy Engine converts state into bounded execution preferences.

Example:

```text
Cognitive State
 ↓
Policy Engine
 ↓
{
  contextDensity: "low",
  responseChunking: "high",
  executionStrategy: "single",
  uiDensity: "reduced"
}
```

These are policies, not direct model commands.

---

## 13. Event Model

```ts
type RunEvent =
  | { type: "run.created"; runId: string }
  | { type: "router.selected"; plan: ExecutionPlan }
  | { type: "agent.started"; agentId: string }
  | { type: "agent.completed"; agentId: string }
  | { type: "model.started"; model: string }
  | { type: "model.completed"; model: string }
  | { type: "tool.started"; tool: string }
  | { type: "tool.completed"; tool: string; result: ToolResult }
  | { type: "evaluation.completed"; score?: number }
  | { type: "response.delta"; delta: string }
  | { type: "run.completed"; runId: string }
  | { type: "run.failed"; runId: string; error: string };
```

Do not include hidden reasoning traces.

---

## 14. API Surface

Core endpoints:

```text
POST   /v1/chat/completions
POST   /v1/runs
GET    /v1/runs/:id
POST   /v1/runs/:id/cancel
GET    /v1/runs/:id/events
WS     /v1/runs/:id/stream

GET    /v1/conversations/:id
POST   /v1/conversations
GET    /v1/memories
POST   /v1/memories/search

GET    /health
GET    /ready
```

---

## 15. Persistence

Core tables:

```text
users
workspaces
conversations
messages
runs
run_events
agents
agent_executions
tool_calls
memories
evaluations
cognitive_sessions
api_keys
```

PostgreSQL stores durable state.

Redis stores transient/coordination state.

---

## 16. Cancellation

Cancellation flow:

```text
User clicks Stop
 ↓
POST /runs/:id/cancel
 ↓
Persist cancellation request
 ↓
Worker observes cancellation
 ↓
Abort current provider/tool operation
 ↓
Stop future execution
 ↓
Emit run.cancelled
```

AbortSignal should propagate through the entire execution stack.

---

## 17. Observability

Use OpenTelemetry.

Trace hierarchy:

```text
HTTP request
 └── run
      ├── routing
      ├── agent
      │    ├── model
      │    └── tool
      ├── evaluation
      └── persistence
```

Capture:

- latency
- model
- provider
- token usage
- tool duration
- retries
- errors
- queue delay
- execution strategy

Never log secrets or private chain-of-thought.

---

## 18. Frontend Architecture

```text
React
 ├── App Shell
 ├── Workspace
 │    ├── Chat Composer
 │    ├── Conversation
 │    ├── Streaming Response
 │    └── Execution Timeline
 │
 ├── Inspector
 │    ├── Run
 │    ├── Model
 │    ├── Agents
 │    ├── Tools
 │    ├── Memory
 │    └── Evaluation
 │
 └── Cognitive Controls
```

The main screen should prioritize:

```text
Ask → Execute → Stream → Inspect
```

not:

```text
Dashboard → Cards → Metrics → Tables
```

---

## 19. Frontend State

Use:

- TanStack Query for server state
- Zustand for local workspace/UI state

Do not duplicate server state unnecessarily in Zustand.

---

## 20. Realtime Transport

Use SSE for simple one-way streaming where appropriate.

Use WebSocket when bidirectional realtime control is required, such as:

- cancellation
- interactive approvals
- execution controls
- live agent/tool updates

The transport layer should be abstracted from the runtime event model.

---

## 21. Testing

Unit:

```text
Vitest
```

Integration:

```text
Fastify + test database
```

E2E:

```text
Playwright
```

Critical test paths:

1. Standard direct request.
2. Tool call.
3. Invalid tool arguments.
4. Unauthorized tool.
5. Tool timeout.
6. Memory retrieval.
7. Single-agent execution.
8. Multi-agent execution.
9. Multi-model execution.
10. Cognitive Mode.
11. Cancellation.
12. Streaming.
13. Provider fallback.
14. Worker restart/recovery.

---

## 22. Deployment

Development:

```text
pnpm
Docker Compose
PostgreSQL
Redis
Qwen/local model or remote provider
```

Production:

```text
Load Balancer
   ↓
Node API replicas
   ↓
Redis
   ↓
BullMQ workers
   ↓
Model Gateway
   ↓
Qwen / Groq

PostgreSQL
OpenTelemetry
```

Frontend can be deployed independently as a static/Vite application behind a CDN.

Backend can scale independently.

---

# Product Phase 1 — Core Runtime Implementation Contract

The implementation of all generic runtime components above must satisfy the Product Phase 1 requirements in `prd.md` before Phase 2 is considered independently complete.

The Phase 1 runtime must expose reusable contracts for:

- durable Run lifecycle and checkpoints
- execution plans and independent agent/model strategies
- model provider normalization
- JSON Schema tool contracts and authorization
- bounded memory retrieval through tools
- evaluation and bounded refinement
- SSE/WebSocket realtime events
- cancellation and retry/fallback
- workspace/resource budgets
- persistence and replayable event history
- authentication, authorization and workspace isolation

Phase 2 must consume these contracts rather than replacing them.

# Product Phase 2 — Code Agent Implementation Design

## 23. Phase 2 Domain Model

The Code Agent is implemented as a specialized execution domain on top of the existing Run model.

Core entities:

```text
CodeWorkspace
RepositoryBinding
BranchState
CodeRun
CodeContext
Patch
Approval
SandboxExecution
TestExecution
GitOperation
PullRequestReference
AgentReplay
ModelLabConfiguration
FineTuningDataset
FineTuningJob
```

A CodeRun must retain references to the base NeuroFlow run/execution system rather than creating an independent runtime.

## 24. Code Workspace Lifecycle

```text
GitHub Authorization
 ↓
Repository Selection
 ↓
Branch Selection
 ↓
Workspace Creation
 ↓
Repository Synchronization
 ↓
Code Workspace Ready
```

Workspace state must include repository, branch, starting commit, synchronization state, modified files and active run.

## 25. Code Agent Request

Conceptually:

```ts
type CodeAgentRequest = {
  workspaceId: string;
  repositoryId: string;
  branch: string;
  instruction: string;
  activeFile?: string;
  selection?: { startLine: number; endLine: number };
  context?: string[];
  approvalMode: "suggest" | "review" | "auto" | "restricted";
};
```

The request is converted into the normal NeuroFlow RunRequest/ExecutionPlan path.

## 26. Repository Context Pipeline

```text
User Request
 ↓
Current Editor Context
 ↓
Repository Search
 ↓
Relevant Files
 ↓
Symbols / References
 ↓
Repository Instructions
 ↓
Tool Results
 ↓
Bounded Code Context
 ↓
Model
```

Do not send an entire repository to the model.

## 27. Code Agent Tool Execution

Every Code Agent tool call follows the standard NeuroFlow tool pipeline:

```text
Model Tool Call
 ↓
Tool Registry
 ↓
Schema Validation
 ↓
Authorization
 ↓
Risk / Approval
 ↓
Sandbox / Repository Service
 ↓
Normalized ToolResult
 ↓
Context Update
 ↓
Model Continuation
```

## 28. Patch Model

A patch should identify:

- run ID
- workspace ID
- repository
- base commit
- affected files
- patch content or patch reference
- validation status
- approval status
- application status

Patch generation must not silently mutate the repository before the approval policy is satisfied.

## 29. Approval Modes

### Suggest
No mutation; proposal only.

### Review
Patch generated and held for explicit approval.

### Auto
Low-risk operations may be applied under policy.

### Restricted
Selected capabilities are disabled.

The mode must be persisted with the run and enforced by the Tool Runtime.

## 30. Sandbox Execution

Command execution must be isolated from the API server.

```text
Fastify
 ↓
Worker
 ↓
Sandbox
 ↓
Repository Workspace
 ↓
Command
```

Sandbox policy controls command allowlists, filesystem boundaries, network access, resource limits, process lifetime and secrets.

## 31. Test and Repair Loop

The Code Agent may execute a bounded repair loop:

```text
Apply Approved Patch
 ↓
Run Tests / Lint / Build
 ↓
Collect Failure
 ↓
Analyze Failure
 ↓
Generate Bounded Patch
 ↓
Review / Apply According To Policy
 ↓
Re-run Validation
```

Maximum repair iterations and resource budgets are mandatory.

## 32. Git Workflow

For substantial changes:

```text
main
 ↓
Create neuroflow/agent/<short-task-name>
 ↓
Modify
 ↓
Test
 ↓
Review Diff
 ↓
Commit
 ↓
Push
 ↓
Optional Pull Request
```

Branch protection and authorization policies remain authoritative.

## 33. Realtime Code Events

Add Phase 2 events to the existing RunEvent model. They must be emitted from actual backend operations and persisted sufficiently for replay.

## 34. Agent Replay

Replay reads stored events and artifacts. It must never re-run the historical task.

Replay should expose:

- user request
- repository/branch
- search activity
- files read
- patch generation
- approvals
- commands
- tests
- final result
- Git operations

Private chain-of-thought is excluded.

## 35. Model Lab

Model Lab is a Phase 2 product surface over the Model Gateway and evaluation infrastructure. React never calls provider SDKs directly.

## 36. Fine-Tuning Domain

Fine-tuning must be represented through provider capability discovery and explicit dataset/job entities. Candidate data can originate from commits, PRs, reviews, accepted/rejected patches, agent interactions and test outcomes, but users must review and control inclusion.

## 37. Phase 2 API Surface

Suggested endpoints:

```text
POST   /v1/code/workspaces
GET    /v1/code/workspaces/:id
POST   /v1/code/workspaces/:id/sync
GET    /v1/code/workspaces/:id/tree
GET    /v1/code/workspaces/:id/file
POST   /v1/code/workspaces/:id/search
POST   /v1/code/runs
GET    /v1/code/runs/:id
GET    /v1/code/runs/:id/events
POST   /v1/code/runs/:id/cancel
POST   /v1/code/runs/:id/approve
POST   /v1/code/runs/:id/reject
GET    /v1/code/runs/:id/diff
POST   /v1/code/runs/:id/commit
POST   /v1/code/runs/:id/push
POST   /v1/code/runs/:id/pull-request
```

Exact routes may be adapted to the existing API conventions, but the capabilities must exist.

## 38. Phase 2 Persistence

Add domain tables or equivalent persistence for:

```text
code_workspaces
repository_bindings
code_runs
code_context_items
code_patches
code_approvals
sandbox_executions
test_executions
git_operations
pull_request_refs
code_replay_events
model_lab_configs
fine_tuning_datasets
fine_tuning_jobs
```

Ownership and workspace isolation must be explicit.


# Phase 1 + Phase 2 Alignment Rules

1. A Code Agent run is a specialized Run, not a separate execution primitive.
2. A Code Agent is a specialized AgentDefinition using the same Agent Runtime.
3. Repository, file, Git and sandbox operations are Tool Runtime capabilities.
4. Repository context is an extension of Context Engine input.
5. Code events extend the common Event model.
6. Code Agent persistence extends Run/artifact persistence with repository, patch, approval, test and Git records.
7. GitHub credentials remain outside model context and are authorized server-side.
8. Model Lab configures the existing Model Gateway; React never invokes provider SDKs directly.
9. Cognitive Mode remains optional and cannot bypass Code Agent security or approval policies.
10. The final implementation must support both ordinary Phase 1 AI tasks and Phase 2 coding tasks in the same deployed runtime.
