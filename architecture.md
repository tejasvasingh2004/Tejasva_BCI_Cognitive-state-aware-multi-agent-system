# NeuroFlow — Production Architecture
Version 4 — TypeScript / React / Node.js

## 1. Product Definition

NeuroFlow is a production-grade AI workspace and execution runtime, not a conventional dashboard.

Its primary interaction is:

1. User asks something.
2. NeuroFlow immediately acknowledges execution.
3. The runtime plans and executes the task.
4. Progress and output stream in real time.
5. The final answer appears naturally.
6. Advanced users may inspect execution metadata without exposing private chain-of-thought.

NeuroFlow supports two user-facing modes:

- Standard Mode — default; no cognitive-state input.
- Cognitive Mode — explicit opt-in; adds cognitive-state signals to normal AI routing.

Cognitive Mode does not replace the normal AI runtime. It adds an additional policy signal.

---

## 2. Technology Stack

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Framer Motion
- TanStack Query
- Zustand
- React Router
- WebSocket and/or SSE for realtime execution
- Zod for client-side contracts where useful

The frontend is a workspace application, not a traditional admin dashboard.

### Backend

- Node.js
- TypeScript
- Fastify
- Zod
- WebSocket support
- REST/OpenAI-compatible HTTP APIs

Fastify is the primary HTTP framework.

### AI Runtime

- Node.js + TypeScript
- Custom NeuroFlow Orchestrator
- Agent Runtime
- Model Gateway
- Tool Runtime
- Context Engine
- Memory Engine
- Evaluation Engine
- Cognitive Runtime

Do not tightly couple the core runtime to React or Next.js.

### Models

Initial providers:

- Qwen
- Groq

The Model Gateway must abstract provider/model differences.

### Data and Infrastructure

- PostgreSQL — durable application/runtime state
- Redis — queues, transient state, pub/sub, rate limits
- BullMQ — background execution
- Docker — local and production packaging
- OpenTelemetry — tracing and observability

Future/optional:

- pgvector
- S3-compatible object storage
- NATS/Kafka
- Kubernetes

---

## 3. High-Level Architecture

```text
                         React + Vite
                         TypeScript UI
                              │
                     REST / SSE / WebSocket
                              │
                              ▼
                     Node.js + Fastify
                         TypeScript
                              │
                       Authentication
                       Request Validation
                       API Boundary
                              │
                              ▼
                         Run Manager
                              │
                        Admission Control
                              │
                         Redis / BullMQ
                              │
                              ▼
                       Worker Runtime
                              │
                              ▼
                     NeuroFlow Orchestrator
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
          ▼                   ▼                    ▼
    Context Engine       Agent Runtime      Cognitive Runtime
          │                   │                    │
          ▼                   ▼                    ▼
    Memory Engine       Model Gateway      Cognitive State
                              │
                       ┌──────┴──────┐
                       ▼             ▼
                      Qwen          Groq
                       │             │
                       └──────┬──────┘
                              ▼
                        Tool Runtime
                              │
                 ┌────────────┼────────────┐
                 ▼            ▼            ▼
              Memory       Search      Custom Tools

                         PostgreSQL
                 durable state / metadata
```

---

## 4. OpenAI-Compatible API Boundary

NeuroFlow exposes:

```text
POST /v1/chat/completions
```

This is an interoperability boundary.

It does NOT mean NeuroFlow must use OpenAI models.

Compatible clients can communicate with NeuroFlow while NeuroFlow internally routes to Qwen, Groq, or future providers.

Canonical flow:

```text
OpenAI SDK / Compatible Client
        │
        ▼
POST /v1/chat/completions
        │
        ▼
Fastify API
        │
        ├── authentication
        ├── request validation
        ├── prompt/context limits
        └── run creation
        │
        ▼
Run Manager
        │
        ▼
Queue / Worker
        │
        ▼
Adaptive Router
        │
        ▼
Execution Strategy
        │
        ▼
Context Engine
        │
        ▼
Model Gateway
        │
        ├── Qwen
        └── Groq
        │
        ▼
Model output
        │
        ├── final answer
        │
        └── tool call
              │
              ▼
        Tool Runtime
              │
        JSON Schema validation
              │
        Authorization
              │
        Risk / approval
              │
        Application execution
              │
        Normalized result
              │
              ▼
        Model resumes
              │
              ▼
        Evaluation
              │
              ▼
        Streaming response
```

---

## 5. Agent and Model Topology

Agent topology and model topology are independent.

Supported combinations:

```text
Single Agent + Single Model
Single Agent + Multi Model
Multi Agent + Single Model
Multi Agent + Multi Model
```

Do not hardcode a particular topology.

The adaptive router selects the smallest reliable execution graph for the task.

---

## 6. Execution Strategies

The runtime supports:

### DIRECT

Simple model request.

### SINGLE_AGENT

One agent owns the task and may call tools.

### SEQUENTIAL

Multiple agents execute in ordered stages.

### PARALLEL

Independent work is executed concurrently.

### SUPERVISOR

A supervisor coordinates specialist agents.

### EVALUATOR_OPTIMIZER

A generator produces an answer, an evaluator checks it, and an optimizer/refiner improves it when necessary.

The runtime may introduce additional strategies later.

---

## 7. Context Engine

The Context Engine builds bounded model context.

Possible components:

```text
System instructions
Current task
Recent messages
Conversation summary
Workspace context
Retrieved memory
Tool results
Execution state
Optional cognitive context
```

Do not treat memory as unlimited prompt injection.

Context must be bounded, prioritized, and observable.

---

## 8. Memory

Memory is a tool/runtime capability.

The model may decide to call:

```text
search_memory
```

Example:

```text
User:
"What did I decide about pricing?"

Model
  ↓
tool_call(
  search_memory,
  {"query":"pricing"}
)
  ↓
Tool schema validation
  ↓
Authorization
  ↓
Memory Service
  ↓
Relevant bounded memories
  ↓
Model
  ↓
Final response
```

Do not hardcode a universal "Need to search memory" branch.

Memory retrieval is a model/tool decision subject to runtime policy.

---

## 9. Tool Runtime

Tool execution must follow:

```text
Model generated tool call
        ↓
Validate tool name
        ↓
Validate arguments against JSON Schema
        ↓
Authorize
        ↓
Risk / approval policy
        ↓
Execute
        ↓
Timeout / retry policy
        ↓
Normalize ToolResult
        ↓
Append result to context
        ↓
Resume model
```

The invariant is schema validation, authorization, and bounded execution.

Zod is the preferred TypeScript validation layer. JSON Schema remains the canonical interoperable contract.

Do not use AJV as a mandatory architectural dependency. AJV may be introduced if a dedicated JSON Schema gateway requires it.

Consequential tools must support approval/human-in-the-loop where appropriate.

---

## 10. Reasoning Control

Do not expose a universal provider-specific parameter such as:

```text
thinking=true
```

Use:

```text
reasoning_budget:
  OFF
  LOW
  MEDIUM
  HIGH
```

The Model Gateway translates this abstraction into provider-specific controls where supported.

Do not expose private chain-of-thought.

The UI may show safe metadata:

- selected model
- agent
- tool
- status
- duration
- token/cost metadata where available
- evaluation status
- retry/fallback status

---

## 11. Cognitive Runtime

Standard Mode:

```text
User
 ↓
Normal AI Runtime
```

Cognitive Mode:

```text
User
 ↓
Cognitive State Provider
 ↓
Cognitive Context
 ↓
Policy Engine
 ↓
Normal AI Runtime
```

Cognitive signals can influence:

- context density
- response presentation
- task chunking
- model/agent strategy
- execution pacing
- UI complexity
- notification intensity

They must not bypass normal authorization or safety controls.

---

## 12. Realtime Runtime

The UI should feel like Cursor/Traycer rather than a dashboard.

Canonical interaction:

```text
User sends request
        ↓
Run created immediately
        ↓
execution.started
        ↓
router.selected
        ↓
agent.started
        ↓
model.started
        ↓
tool.started
        ↓
tool.completed
        ↓
model.completed
        ↓
evaluation.completed
        ↓
response.delta
        ↓
run.completed
```

These events are actual backend events.

Do not fabricate frontend-only progress.

---

## 13. Scalability

Production topology:

```text
Load Balancer
      │
 ┌────┴────┐
 │         │
API       API
 │         │
 └────┬────┘
      │
    Redis
      │
   BullMQ
      │
 ┌────┴──────────────┐
 │                   │
Worker              Worker
 │                   │
 └────────┬──────────┘
          │
     AI Orchestrator
          │
   ┌──────┴──────┐
   │             │
Model Gateway  Tool Runtime
   │
Qwen / Groq

PostgreSQL ← durable state
OpenTelemetry ← observability
```

The API layer must remain stateless where possible.

Long-running AI work belongs in workers, not inside request handlers.

---

## 14. Architecture Invariants

1. Standard Mode is a complete production AI runtime.
2. Cognitive Mode is an additional signal, not a replacement runtime.
3. Agent and model topology are independent.
4. OpenAI compatibility is an API boundary, not a model dependency.
5. Tool calls are schema validated.
6. Tool calls are authorized before execution.
7. Memory is a bounded tool/capability.
8. Provider-specific reasoning controls stay behind the Model Gateway.
9. Private chain-of-thought is never exposed.
10. Long-running execution is worker-based.
11. Realtime UI events originate from real backend execution.
12. UI complexity is hidden by default but inspectable.
13. The core AI runtime is independent of React.
14. The backend is TypeScript/Node.js and independently deployable from the frontend.
