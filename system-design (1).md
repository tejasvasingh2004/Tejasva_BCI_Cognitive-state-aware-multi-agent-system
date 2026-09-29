# NeuroFlow — System Design
Version 4 — React + Node.js + TypeScript

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
