# NeuroFlow — Production Architecture
Version 6 — Phase 1 + Phase 2 Aligned

> Source of truth: `prd.md`. This document explains the architecture required to implement both product phases without creating a second runtime.

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

For Product Phase 2 it additionally includes:

- Monaco Editor
- repository explorer/search UI
- terminal/problems/tests/Git Diff/Agent Logs surfaces
- GitHub repository/branch controls
- diff review and approval UI
- Ctrl/Cmd+K code command bar

### Backend

- Node.js
- TypeScript
- Fastify
- Zod
- WebSocket support
- REST/OpenAI-compatible HTTP APIs

Fastify is the primary HTTP framework.

Phase 2 adds GitHub integration, isolated code execution/sandbox orchestration, and code-workspace APIs without bypassing the shared runtime.

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

## 3. Product Phase 1 — Core Runtime Foundation

Product Phase 1 is the complete general-purpose NeuroFlow AI runtime. It is the foundation on which every later workspace, including the Phase 2 Code Agent, must execute.

Phase 1 provides:

- React/Vite/TypeScript AI workspace
- Fastify API and OpenAI-compatible boundary
- Run Manager and durable Runs
- Redis/BullMQ workers
- NeuroFlow Orchestrator
- Adaptive Router
- Context Engine
- Model Gateway with Qwen and Groq
- independent agent/model strategies
- Tool Runtime with JSON Schema contracts, validation, authorization, risk and approval
- Memory as a bounded tool/capability
- Evaluation
- realtime events and streaming
- cancellation, retry, fallback, idempotency and resource budgets
- PostgreSQL persistence
- OpenTelemetry observability
- Standard Mode and optional Cognitive Mode

Phase 1 is not a disposable prototype. Its contracts must already support Phase 2 concepts such as workspace context, repository-scoped tools, approvals, long-running code runs, sandbox execution, Git operations, and richer realtime events.

### Phase 1 → Phase 2 architectural rule

Phase 2 MUST specialize Phase 1 rather than fork it:

```text
                    NeuroFlow Runtime
                           │
        ┌──────────────────┴──────────────────┐
        │                                     │
 Core AI Workspace                     Code Agent Workspace
 Product Phase 1                       Product Phase 2
        │                                     │
        └────────────── shared ───────────────┘
          Run Manager / Orchestrator / Agents
          Model Gateway / Tools / Context
          Memory / Evaluation / Events
          Authorization / Observability
```

Phase 2 may add domain-specific services, tools, persistence and UI, but it must not introduce a parallel model runtime, agent runtime, tool runtime, or event architecture.

## 4. High-Level Architecture

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

## 5. OpenAI-Compatible API Boundary

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

## 6. Agent and Model Topology

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

## 7. Execution Strategies

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

## 8. Context Engine

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

## 9. Memory

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

## 10. Tool Runtime

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

## 11. Reasoning Control

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

## 12. Cognitive Runtime

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

## 13. Realtime Runtime

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

## 14. Scalability

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

### Implemented scalability controls

All shared state lives in PostgreSQL and Redis, so API and worker replicas can be added without
code changes. The controls below already work across processes:

```text
Request
  ↓
Per-IP and per-tenant HTTP token buckets (plan × route class)     apps/api/src/rate-limit.ts
  ↓
Admission: active runs per workspace/user, daily token quota,     apps/api/src/run-manager.ts
           global backlog
  ↓
Queues: neuroflow-runs | neuroflow-workspace | neuroflow-evals     packages/bus/src/queue.ts
        priority = plan priority × 10 + source
  ↓
Worker fairness gate: running slots per workspace (Redis lease)   apps/worker/src/workers.ts
  ↓
Model Gateway: shared provider token/request buckets per key,     packages/bus/src/rate-limit.ts
               concurrency leases, retry-after blocks, key pools  packages/models/src/gateway.ts
               circuit breaker per provider                       packages/models/src/circuit-breaker.ts
```

Plans (free / pro / team / enterprise) are the single source of limits
(`packages/contracts/src/plan-limits.ts`). Load balancing, Redis HA and connection pooling are
infrastructure steps tracked in `ROADMAP.md`.

---

## 15. Architecture Invariants

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

---

# 16. Product Phase 2 — AI Code Agent / AI IDE Workspace

Phase 2 is a specialized coding workspace built directly on the Phase 1 NeuroFlow runtime. It does not introduce a second AI architecture.

## 16.1 Phase 2 Runtime Reuse

Phase 2 reuses:

- Model Gateway
- Agent Runtime
- Tool Runtime
- Context Engine
- Memory
- Evaluation
- Run Manager
- Realtime Events
- Authorization
- Observability

The Code Agent is a specialized agent definition and workspace experience, not a separate model-serving stack.

## 16.2 Phase 2 High-Level Architecture

```text
GitHub
  ↓
Repository / Branch
  ↓
Code Agent Workspace
  ├── Repository Explorer
  ├── Monaco Editor
  ├── Agent Panel
  └── Terminal / Problems / Tests / Git Diff / Agent Logs
          ↓
      Code Agent Run
          ↓
  Repository Understanding
          ↓
        Plan
          ↓
   Search / Read / Context
          ↓
     Patch Generation
          ↓
      Diff Review
          ↓
 Approval Policy / User Approval
          ↓
        Apply Patch
          ↓
 Sandbox Execution
          ↓
 Tests / Lint / Build
          ↓
   Bounded Repair Loop
          ↓
       Final Diff
          ↓
 Commit / Push / Optional PR
```

## 16.3 Repository Integration Boundary

GitHub access must be isolated behind repository/GitHub capabilities. The model never receives unrestricted GitHub credentials.

The architecture must preserve:

- repository authorization
- workspace isolation
- branch protection awareness
- explicit write permissions
- auditability

## 16.4 Code Workspace Boundary

The browser editor is a user-facing workspace. Repository operations, command execution, and GitHub mutations occur through backend tools and isolated execution environments.

Never execute arbitrary agent commands on the Fastify API process.

```text
React
 ↓
Fastify
 ↓
Run Manager
 ↓
Worker
 ↓
Code Agent
 ↓
Tool Runtime
 ├── Repository Tools
 ├── Editing Tools
 ├── Git Tools
 └── GitHub Tools
 ↓
Sandbox where execution is required
```

## 16.5 Code Agent Tool Families

Repository:

```text
list_files
read_file
search_code
find_symbol
find_references
```

Editing:

```text
create_file
edit_file
rename_file
delete_file
apply_patch
```

Execution:

```text
run_command
run_tests
run_linter
run_build
```

Git:

```text
git_status
git_diff
git_log
create_branch
commit
push
```

GitHub:

```text
get_repository
get_branch
get_pull_requests
get_issues
create_issue
create_pull_request
review_pull_request
```

Every tool uses the existing Tool Runtime contract, validation, authorization, risk policy, timeout and approval mechanisms.

## 16.6 Code Editing Safety Invariant

All agent modifications follow:

```text
Understand
 ↓
Generate Patch
 ↓
Validate
 ↓
Show Diff
 ↓
Approval Policy
 ↓
Apply
```

Targeted patches are preferred over whole-file replacement.

## 16.7 Code Execution Isolation

Sandbox controls must cover:

- filesystem access
- CPU
- memory
- network
- process lifetime
- allowed commands
- environment variables
- secrets

## 16.8 Phase 2 Realtime Events

The runtime must emit real events including:

```text
code.run.created
repository.loaded
agent.plan.created
file.search.started
file.search.completed
file.read
patch.generated
patch.review_required
patch.approved
file.modified
command.started
command.output
command.completed
test.started
test.completed
git.diff.updated
commit.created
push.completed
pull_request.created
code.run.completed
```

## 16.9 Code Agent Persistence

Persist repository, branch, starting commit, user request, execution plan, tool calls, files read/modified, diffs, test results, evaluation, approvals, final status, and commit/PR references.

## 16.10 Phase 2 Model Layer

The Code Agent uses the same Model Gateway and supports Qwen and Groq. Provider-specific controls remain behind the gateway.

The workspace may expose:

```text
Provider
Model
Reasoning Budget
Temperature where supported
Tool Policy
Agent Strategy
Context Strategy
```

## 16.11 Model Lab and Fine-Tuning

Phase 2 includes a Model Lab surface for:

```text
Models
Providers
Parameters
Datasets
Fine-tuning
Evaluations
Deployments
```

Fine-tuning is provider-dependent. The UI must distinguish available, unavailable, provider-access-required, and coming-soon states. Private repository content must never automatically become training data.

## 16.12 Completion Architecture

Phase 2 is not complete because Monaco renders successfully. The real-repository loop must work:

```text
GitHub → Repository → Code Agent → Understanding → Plan → Edit
→ Diff → Approval → Test → Fix → Final Diff → Commit → Push → Optional PR
```

## 16.13 Plan Review, Tasks and Workspace Settings

Plan Review is an optional gate inside the Code Agent strategy, built on the same approval channel
as patch review:

```text
Plan → plan.review_required → user decision
         ├─ approve (as is or with edited steps) → plan.approved → explore → patch → test …
         ├─ revise (feedback, at most 3 new plans) → new plan → review again
         └─ reject → plan.rejected → run ends; the repository is untouched
```

It is enabled per task or by the workspace default. Workspace Settings hold per-workspace defaults
(approval mode, default model, Plan Review default, project command overrides, sandbox image from a
curated list) in `code_workspaces.settings`; new code runs apply them unless the request overrides
them. The Tasks view is a read model over existing run records — status, timing, cost, tokens, diff
stats, tests, agent branch and pull request — with Replay for any run.

---

# 17. Delivery Surfaces and Deployment

```text
apps/site  (marketing, pre-rendered static)   ──► static CDN (Vercel)
apps/web   (product UI, static SPA)           ──► static CDN (Vercel)
                    │  HTTPS / SSE / WebSocket
                    ▼
apps/api   (Fastify, stateless)               ──► Railway (Nixpacks) or Docker
apps/worker (BullMQ, sandbox via Docker)      ──► separate process from the same build
PostgreSQL · Redis                            ──► managed services
```

The marketing site never shares a deploy or bundle with the product. The web app talks to the API
only over its public HTTP API; provider keys and GitHub credentials stay on the server. Self-hosting
uses Docker Compose with the same images.
