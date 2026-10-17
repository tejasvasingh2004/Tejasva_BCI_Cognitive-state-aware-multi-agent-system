# NeuroFlow — Product Requirements Document
## Version 5 — Deep Product & Engineering Requirements
### TypeScript / React / Node.js Architecture

---

# 1. DOCUMENT PURPOSE

This document defines what NeuroFlow is, what the system must implement, how the product should behave, how users interact with it, how the AI runtime operates, and what constitutes a complete implementation.

This is not a high-level feature list.

It is the primary product requirement specification for implementation.

The implementation team should use this document together with:

- `architecture.md`
- `system-design.md`
- `brain-dump.md`
- `progress.md`
- `claude.md`

When these documents conflict, the implementation team must identify the conflict explicitly rather than silently choosing an interpretation.

---

# 2. PRODUCT DEFINITION

## 2.1 What NeuroFlow Is

NeuroFlow is a production-oriented AI workspace and AI execution runtime.

It combines:

1. A polished interactive AI workspace.
2. A model abstraction layer.
3. A task execution engine.
4. Single-agent and multi-agent orchestration.
5. Single-model and multi-model execution.
6. Tool calling.
7. Persistent memory.
8. Context management.
9. Evaluation.
10. Realtime execution visibility.
11. Optional cognitive-state adaptation.
12. Production infrastructure for long-running AI workloads.

NeuroFlow is intended to feel like an AI-native development/workspace environment rather than a conventional chatbot.

---

## 2.2 What NeuroFlow Is Not

NeuroFlow must not become:

- a basic chat application,
- a thin wrapper around one LLM,
- a dashboard full of analytics cards,
- a collection of disconnected demo agents,
- a frontend that directly calls model providers,
- a system where every task is automatically multi-agent,
- a system where every request is forced through every available tool,
- a system that exposes private chain-of-thought,
- a collection of fake realtime animations,
- a monolithic HTTP request that blocks while an AI task runs.

---

# 3. PRODUCT VISION

The core experience is:

```text
USER HAS A TASK
       ↓
USER ASKS NEUROFLOW
       ↓
SYSTEM ACKNOWLEDGES IMMEDIATELY
       ↓
TASK EXECUTION STARTS
       ↓
USER SEES LIVE EXECUTION STATE
       ↓
AI MODELS / AGENTS / TOOLS WORK
       ↓
RESULT STREAMS BACK
       ↓
SYSTEM EVALUATES RESULT
       ↓
FINAL ANSWER IS PRESENTED
       ↓
USER CAN INSPECT EXECUTION IF DESIRED
```

The product should hide unnecessary complexity while retaining deep execution capabilities underneath.

---

# 4. PRODUCT PRINCIPLES

## 4.1 Simple Surface, Powerful Runtime

A normal user should be able to use NeuroFlow without knowing:

- what an agent is,
- which model was selected,
- how memory retrieval works,
- how tools are executed,
- how queues work,
- how the task was orchestrated.

Advanced users must be able to inspect these details.

---

## 4.2 Complexity Must Be Available, Not Forced

The system should use the smallest reliable execution strategy.

Examples:

### Simple task

```text
User
 ↓
Model
 ↓
Answer
```

### Tool task

```text
User
 ↓
Agent
 ↓
Tool
 ↓
Model
 ↓
Answer
```

### Complex task

```text
Supervisor
 ├── Research Agent
 ├── Analysis Agent
 └── Evaluation Agent
       ↓
    Final Answer
```

The product must not make a simple request unnecessarily expensive or slow.

---

## 4.3 Realtime Is a Product Requirement

Realtime behavior is not decorative.

The backend must produce real execution events.

The frontend must render those events.

Fake progress indicators are not acceptable as the primary execution mechanism.

---

## 4.4 Production Runtime, Not Prototype Runtime

The system must be designed for:

- concurrent users,
- long-running tasks,
- model failures,
- tool failures,
- cancellation,
- retries,
- worker restarts,
- queue backpressure,
- provider fallback,
- observability,
- authorization,
- persistent execution state.

---

# 5. TARGET USERS

## 5.1 Primary User

A technical user who wants one workspace for:

- asking AI questions,
- performing complex tasks,
- using tools,
- retrieving information,
- executing multi-step work,
- inspecting AI execution,
- working with persistent context.

---

## 5.2 Advanced User

A developer, researcher, power user, or AI engineer who wants to inspect:

- selected model,
- model routing,
- agent strategy,
- agent execution,
- tool calls,
- memory retrieval,
- evaluation,
- latency,
- retries,
- failures,
- execution graph.

---

## 5.3 Future User Categories

The architecture should allow:

- teams,
- organizations,
- workspace administrators,
- API consumers,
- application developers integrating NeuroFlow through the OpenAI-compatible API.

---

# 6. CORE PRODUCT MODES

# 6.1 Standard Mode

Standard Mode is the default.

It must be a complete AI runtime.

It must support:

- direct model execution,
- model routing,
- single-agent execution,
- multi-agent execution,
- tools,
- memory,
- context management,
- evaluation,
- streaming,
- realtime execution events,
- cancellation,
- retries,
- provider fallback.

Standard Mode must not depend on cognitive-state availability.

---

# 6.2 Cognitive Mode

Cognitive Mode is explicitly enabled.

It adds cognitive-state information to the normal execution system.

Architecture:

```text
Cognitive State
      ↓
Cognitive Context
      ↓
Cognitive Policy
      ↓
Normal NeuroFlow Runtime
```

Cognitive Mode must not duplicate the entire AI runtime.

---

## 6.2.1 Cognitive Inputs

The architecture must support a pluggable cognitive-state provider.

Possible future inputs include:

- BCI-derived state,
- workload estimates,
- attention estimates,
- fatigue estimates,
- interaction-derived state.

The exact sensor/model implementation must remain behind an interface.

---

## 6.2.2 Cognitive Outputs

Cognitive policy may influence:

- response density,
- task chunking,
- context density,
- UI density,
- execution strategy,
- notification intensity,
- model/agent policy.

Cognitive policy must never bypass:

- authentication,
- authorization,
- tool safety,
- user permissions,
- approval requirements.

---

# 7. USER EXPERIENCE REQUIREMENTS

# 7.1 Main Workspace

The primary screen should be a workspace.

It should prioritize:

1. Conversation.
2. Composer.
3. Execution state.
4. Streaming output.
5. Optional execution inspector.

It should not prioritize:

- static analytics,
- admin tables,
- decorative metrics,
- configuration screens.

---

# 7.2 Composer

The composer is the main entry point for tasks.

It must support:

- text input,
- multiline input,
- submit,
- stop/cancel,
- retry,
- model selection,
- mode selection,
- optional tool selection,
- optional agent strategy selection.

Advanced controls should be collapsible.

---

# 7.3 Task Submission

When the user submits a task:

1. The UI must immediately enter a running state.
2. The API must create a durable run.
3. The run must receive an identifier.
4. The execution must be queued or started.
5. Realtime events must become available.
6. The UI must begin rendering execution state.
7. Model output must stream as soon as available.

The UI must never require the user to refresh the page to see execution progress.

---

# 7.4 Streaming Response

Streaming must support incremental response output.

The UI should:

- render text progressively,
- maintain readable formatting,
- show generation state,
- handle completion,
- handle failure,
- handle cancellation,
- recover from reconnects when possible.

---

# 7.5 Execution State

The user should see concise, human-readable execution states.

Examples:

- Starting task
- Selecting execution strategy
- Working with memory
- Researching
- Running tool
- Analyzing
- Evaluating
- Writing response
- Completed

These are summaries of actual runtime events.

They must not claim that an operation happened if it did not happen.

---

# 7.6 Execution Inspector

The inspector is an advanced feature.

It should expose execution metadata without exposing private reasoning.

Sections:

### Run

- Run ID
- status
- created time
- start time
- completion time
- duration

### Strategy

- mode
- task class
- execution strategy
- model strategy

### Models

- provider
- model
- role
- latency
- usage metadata where available

### Agents

- agent name
- role
- status
- duration

### Tools

- tool name
- status
- duration
- approval status

### Memory

- whether memory was queried
- query metadata
- number of retrieved items
- source metadata

### Evaluation

- evaluation status
- evaluation metadata
- whether refinement occurred

### Reliability

- retries
- fallback
- timeout
- failure reason if applicable

Private chain-of-thought must not appear.

---

# 8. CONVERSATIONS

## 8.1 Conversation Model

A conversation is a persistent user interaction context.

It contains:

- messages,
- run references,
- summaries,
- optional workspace context,
- memory associations.

---

## 8.2 Conversation Requirements

The system must support:

- create conversation,
- rename conversation,
- retrieve conversation,
- continue conversation,
- delete/archive according to product policy,
- load historical runs,
- resume viewing completed executions.

---

# 9. RUNS

A Run represents one execution of a user task.

A run must have:

- unique ID,
- workspace ID,
- conversation ID where applicable,
- status,
- mode,
- execution plan,
- timestamps,
- event history,
- result metadata,
- failure information if applicable.

---

## 9.1 Run Lifecycle

```text
CREATED
 ↓
QUEUED
 ↓
RUNNING
 ↓
COMPLETED
```

Alternative terminal states:

```text
FAILED
CANCELLED
```

---

## 9.2 Run Persistence

Run state must survive:

- browser refresh,
- frontend reconnect,
- API restart,
- worker restart where recoverable.

---

# 10. AI EXECUTION ENGINE

The AI execution engine is the core of NeuroFlow.

It must coordinate:

- routing,
- context,
- agents,
- models,
- tools,
- memory,
- evaluation,
- streaming,
- cancellation.

---

# 11. REQUEST PROCESSING PIPELINE

Canonical pipeline:

```text
Compatible Client / React
        ↓
Fastify API
        ↓
Authentication
        ↓
Request Validation
        ↓
Prompt/Context Limits
        ↓
Run Creation
        ↓
Queue Admission
        ↓
Worker
        ↓
Mode Resolution
        ↓
Adaptive Router
        ↓
Execution Strategy
        ↓
Context Engine
        ↓
Agent/Model Runtime
        ↓
Tool Runtime if required
        ↓
Evaluation
        ↓
Streaming / Final Response
        ↓
Run Completion
```

---

# 12. OPENAI-COMPATIBLE API

NeuroFlow must expose:

```text
POST /v1/chat/completions
```

The endpoint exists for interoperability.

It does not require OpenAI models internally.

The request must be translated into NeuroFlow's internal runtime model.

---

## 12.1 Compatibility Requirements

The API should support, where applicable:

- messages,
- model selection,
- streaming,
- tool definitions,
- tool choice,
- metadata,
- temperature/provider-compatible parameters where meaningful.

Provider-specific features must not leak into the core runtime.

---

# 13. MODEL SYSTEM

# 13.1 Model Gateway

All model calls must pass through the Model Gateway.

The Model Gateway is responsible for:

- provider selection,
- model selection,
- request normalization,
- response normalization,
- streaming,
- timeout,
- retry,
- fallback,
- usage metadata,
- reasoning configuration.

---

# 13.2 Initial Providers

The first production integrations are:

- Qwen
- Groq

The architecture must allow additional providers later.

---

# 13.3 Single Model

Single-model execution means one selected model performs the relevant task.

Example:

```text
User
 ↓
Router
 ↓
Qwen
 ↓
Answer
```

---

# 13.4 Multi Model

Multi-model execution means multiple models may participate.

Example:

```text
Task
 ↓
Model A — research
 ↓
Model B — analysis
 ↓
Model C — synthesis
```

The router decides whether multi-model execution is justified.

---

# 13.5 Reasoning Budget

NeuroFlow must not define a universal provider-specific:

```text
thinking=true
```

Instead define:

```text
OFF
LOW
MEDIUM
HIGH
```

The Model Gateway translates this abstraction to provider capabilities.

---

# 14. AGENT SYSTEM

# 14.1 Agent Definition

An agent is an execution role with:

- instructions,
- capabilities,
- tools,
- model policy,
- limits,
- output contract.

---

# 14.2 Single Agent

Single-agent execution is appropriate for tasks requiring:

- tool use,
- iterative reasoning,
- memory,
- moderate planning.

---

# 14.3 Multi-Agent

Multi-agent execution supports:

- sequential workflows,
- parallel workflows,
- supervisor workflows,
- evaluator/optimizer workflows.

---

# 14.4 Sequential

Example:

```text
Research
 ↓
Analyze
 ↓
Draft
 ↓
Evaluate
```

Each stage receives the output needed from previous stages.

---

# 14.5 Parallel

Independent subtasks may run concurrently.

Example:

```text
                Task
                 ↓
        ┌────────┼────────┐
        ↓        ↓        ↓
    Research   Data    Validation
        └────────┼────────┘
                 ↓
              Synthesis
```

The system must not parallelize tasks that have dependencies.

---

# 14.6 Supervisor

A supervisor may:

- decompose a task,
- delegate,
- collect outputs,
- decide next action,
- request refinement.

Supervisor loops must have hard execution limits.

---

# 14.7 Evaluator/Optimizer

A generated result may be evaluated and refined.

```text
Generator
   ↓
Evaluator
   ↓
Pass → Final
Fail → Optimizer
          ↓
       Evaluate
```

Maximum iterations must be bounded.

---

# 15. AGENT/MODEL INDEPENDENCE

The runtime must support:

```text
Single Agent + Single Model
Single Agent + Multi Model
Multi Agent + Single Model
Multi Agent + Multi Model
```

Agent strategy and model strategy must be separate policy dimensions.

---

# 16. ADAPTIVE ROUTER

The router determines how the task should execute.

It should consider:

- task complexity,
- task category,
- required tools,
- latency budget,
- cost budget,
- model capabilities,
- agent capabilities,
- user-selected constraints,
- cognitive policy when enabled.

The router should produce an execution plan.

---

## 16.1 Execution Plan

Conceptually:

```text
mode
taskClass
agentStrategy
modelStrategy
selectedModels
toolPolicy
contextPolicy
reasoningBudget
evaluationPolicy
```

---

# 17. CONTEXT ENGINE

The Context Engine constructs the model input.

Potential context sources:

1. System instructions.
2. Current task.
3. Recent conversation.
4. Conversation summary.
5. Workspace context.
6. Retrieved memory.
7. Tool results.
8. Execution state.
9. Cognitive context.

---

## 17.1 Context Requirements

Context must be:

- bounded,
- prioritized,
- deduplicated,
- observable,
- relevant.

The system must not blindly include all available information.

---

# 18. MEMORY SYSTEM

Memory is a first-class capability.

---

## 18.1 Memory Retrieval

Example:

```text
User:
"What did I decide about pricing?"

Model
 ↓
search_memory("pricing")
 ↓
Memory Service
 ↓
Relevant results
 ↓
Model
 ↓
Answer
```

Memory retrieval must be bounded.

---

## 18.2 Memory Storage

The system should support storing durable information that is appropriate for future use.

Memory storage must respect:

- authorization,
- workspace boundaries,
- user controls,
- retention policy.

---

## 18.3 Memory Must Not Be Mandatory

A request should not query memory unless:

- the model/runtime determines it is useful,
- user configuration requires it,
- or a specific workflow explicitly requires it.

---

# 19. TOOL SYSTEM

Tools allow the AI runtime to interact with capabilities outside pure text generation.

Potential tools include:

- memory,
- workspace retrieval,
- file operations,
- search,
- external integrations,
- custom user tools.

---

# 20. TOOL CONTRACT

Every tool must define:

```text
name
description
input JSON Schema
risk level
authorization policy
approval requirement
timeout
```

---

# 21. TOOL EXECUTION PIPELINE

```text
Model Tool Call
      ↓
Tool Registry
      ↓
Tool Name Validation
      ↓
Argument Schema Validation
      ↓
Authorization
      ↓
Risk Evaluation
      ↓
Human Approval if required
      ↓
Execution
      ↓
Timeout / Retry
      ↓
Normalized ToolResult
      ↓
Context Update
      ↓
Model Continuation
```

---

# 22. TOOL SAFETY

The runtime must prevent:

- unknown tools,
- malformed arguments,
- unauthorized tools,
- unbounded tool loops,
- unlimited execution time,
- unsafe automatic side effects.

High-impact operations should require approval.

---

# 23. MEMORY AS A TOOL

Memory should use the same tool infrastructure where practical.

For example:

```text
search_memory
```

This ensures memory retrieval receives:

- schema validation,
- authorization,
- tracing,
- timeout,
- bounded result handling.

---

# 24. EVALUATION SYSTEM

Evaluation is part of the runtime rather than a future add-on.

The system should be able to evaluate:

- final response quality,
- tool execution success,
- task completion,
- execution trajectory,
- policy compliance,
- structured output validity.

---

## 24.1 Evaluation Result

An evaluation may produce:

```text
passed
failed
needs_refinement
```

with structured metadata.

---

## 24.2 Evaluation Must Not Automatically Mean Another Model Call

A simple task may only need final validation.

Complex tasks may use:

```text
generate
 ↓
evaluate
 ↓
refine
 ↓
evaluate
```

Iteration must be bounded.

---

# 25. REALTIME EVENT SYSTEM

Every meaningful execution stage should be representable as an event.

Examples:

```text
run.created
run.queued
run.started

router.started
router.selected

agent.started
agent.completed

model.started
model.delta
model.completed

tool.started
tool.completed

memory.started
memory.completed

evaluation.started
evaluation.completed

response.delta

run.completed
run.failed
run.cancelled
```

---

# 26. REALTIME TRANSPORT

## SSE

Preferred for:

- one-way streaming,
- model response streaming,
- execution events.

## WebSocket

Preferred when the client must actively control execution:

- cancellation,
- approval,
- interactive controls,
- future collaborative execution.

The internal event model must remain transport-independent.

---

# 27. CANCELLATION

Users must be able to stop execution.

Cancellation must propagate through:

```text
UI
 ↓
API
 ↓
Run
 ↓
Worker
 ↓
Orchestrator
 ↓
Model
 ↓
Tool
```

Cancellation should prevent future steps from starting.

The system should attempt to abort currently running operations where supported.

---

# 28. RETRIES AND FALLBACK

The runtime must distinguish:

### Retryable errors

Examples:

- transient provider error,
- temporary network failure,
- temporary queue infrastructure issue.

### Non-retryable errors

Examples:

- invalid tool arguments,
- authorization denial,
- malformed request,
- invalid API key,
- user cancellation.

Retries must be bounded.

Side-effecting operations must not be blindly retried.

---

# 29. FAILURE EXPERIENCE

When a run fails:

1. The run becomes `failed`.
2. The user receives a clear message.
3. The execution inspector shows the failure stage.
4. Sensitive infrastructure details are hidden.
5. Retry may be offered when safe.
6. The run history remains available.

---

# 30. FRONTEND ARCHITECTURE

The frontend is a dedicated React application.

Suggested structure:

```text
App Shell
 ├── Workspace
 │    ├── Conversation
 │    ├── Composer
 │    ├── Run Status
 │    └── Streaming Response
 │
 ├── Inspector
 │    ├── Run
 │    ├── Strategy
 │    ├── Models
 │    ├── Agents
 │    ├── Tools
 │    ├── Memory
 │    └── Evaluation
 │
 └── Settings
```

---

# 31. VISUAL DESIGN REQUIREMENTS

The UI should be:

- minimal,
- smooth,
- responsive,
- animation-aware,
- information-dense only when necessary,
- keyboard-friendly,
- fast.

Motion should communicate state rather than decorate the screen.

---

# 32. RESPONSIVE BEHAVIOR

The workspace must adapt to:

- desktop,
- laptop,
- tablet where practical.

The primary desktop experience should optimize for AI workspace productivity.

---

# 33. STATE MANAGEMENT

Use:

- TanStack Query for server state.
- Zustand for local UI/workspace state.

The frontend must not become the authoritative store for run state.

---

# 34. BACKEND ARCHITECTURE

The backend is Node.js + TypeScript.

Use Fastify for:

- REST API,
- OpenAI-compatible API,
- SSE,
- WebSocket,
- authentication middleware,
- validation,
- health endpoints.

---

# 35. WORKER ARCHITECTURE

Long-running execution must happen in workers.

```text
Fastify
 ↓
Redis
 ↓
BullMQ
 ↓
Worker
 ↓
Orchestrator
```

API processes should remain responsive even while complex AI tasks execute.

---

# 36. DATABASE REQUIREMENTS

PostgreSQL should persist:

- users,
- workspaces,
- conversations,
- messages,
- runs,
- run events,
- agent executions,
- tool calls,
- memories,
- evaluations,
- API keys,
- cognitive sessions.

Use migrations.

Data models must have clear ownership and relationships.

---

# 37. AUTHENTICATION

The system must support an authentication boundary.

Requirements:

- authenticated users,
- workspace isolation,
- API authentication,
- API key support for programmatic clients,
- session management appropriate to the chosen frontend auth architecture.

---

# 38. AUTHORIZATION

Authorization must exist at:

- workspace level,
- resource level,
- tool level,
- memory level,
- API level.

A model-generated tool call must never be treated as authorization.

---

# 39. API KEYS

Programmatic API keys must:

- be securely stored,
- be revocable,
- have workspace association,
- have scopes where applicable,
- never be returned in plaintext after creation.

---

# 40. SECURITY

Minimum security requirements:

- input validation,
- authentication,
- authorization,
- rate limiting,
- secret management,
- secure logging,
- workspace isolation,
- tool permission enforcement,
- approval for consequential actions,
- bounded model/tool execution.

---

# 41. OBSERVABILITY

Use OpenTelemetry.

Every run should have a correlation identity.

Trace:

```text
HTTP Request
 ↓
Run
 ↓
Router
 ↓
Agent
 ↓
Model
 ↓
Tool
 ↓
Evaluation
```

Track:

- request latency,
- queue latency,
- model latency,
- tool latency,
- run duration,
- retries,
- provider failures,
- token usage where available,
- error rates.

---

# 42. LOGGING

Use structured logs.

Logs should contain useful metadata such as:

- request ID,
- run ID,
- workspace ID,
- component,
- event,
- duration,
- status.

Never log:

- passwords,
- API keys,
- secrets,
- sensitive credentials,
- private chain-of-thought.

---

# 43. PERFORMANCE REQUIREMENTS

The system must optimize for perceived and actual responsiveness.

Requirements:

1. API acknowledgement should be fast.
2. Long-running work must leave the request handler quickly.
3. Streaming should begin as soon as meaningful output is available.
4. UI rendering must remain responsive during execution.
5. Queue latency must be observable.
6. Model latency must be observable.
7. Tool latency must be observable.
8. Cancellation should propagate promptly.

Exact numeric SLOs should be established after baseline measurement rather than invented before deployment data exists.

---

# 44. SCALABILITY

The initial architecture should support horizontal scaling.

```text
Load Balancer
      ↓
API Replica 1
API Replica 2
API Replica N
      ↓
Redis
      ↓
Worker 1
Worker 2
Worker N
      ↓
Model Gateway
      ↓
Providers
```

PostgreSQL remains the durable state layer.

The architecture should avoid requiring all work to live in one process.

---

# 45. CONCURRENCY

The system must support multiple simultaneous runs.

Concurrency must be controlled using:

- queue limits,
- workspace limits,
- user limits,
- provider limits,
- tool limits,
- resource budgets.

One expensive task must not block unrelated requests.

---

# 46. RESOURCE BUDGETS

Each run should have bounded resources.

Potential budgets:

- maximum duration,
- maximum model calls,
- maximum tool calls,
- maximum agent iterations,
- maximum evaluation iterations,
- maximum context size,
- maximum cost where measurable.

Budgets prevent runaway autonomous loops.

---

# 47. IDEMPOTENCY

Run creation and side-effecting operations should use idempotency where appropriate.

Duplicate requests must not accidentally create duplicate irreversible actions.

---

# 48. CONFIGURATION

Provider credentials and infrastructure configuration must come from environment/secret configuration.

Do not hardcode:

- API keys,
- database passwords,
- Redis credentials,
- provider secrets.

---

# 49. DEVELOPMENT ENVIRONMENT

The project should support local development using Docker Compose for infrastructure.

Expected development services:

```text
PostgreSQL
Redis
NeuroFlow API
NeuroFlow Worker
NeuroFlow Web
```

Qwen may be local or remotely hosted depending on the chosen provider/runtime.

---

# 50. TESTING REQUIREMENTS

## Unit Tests

Test:

- router,
- context builder,
- model gateway,
- tool validation,
- authorization,
- memory service,
- evaluation,
- execution strategies.

## Integration Tests

Test:

- API → queue,
- queue → worker,
- worker → model,
- model → tool,
- tool → model,
- persistence,
- realtime events.

## E2E Tests

Test complete user flows:

### Flow 1

User asks simple question.

### Flow 2

User asks task requiring memory.

### Flow 3

User triggers tool call.

### Flow 4

Tool call contains invalid arguments.

### Flow 5

Tool call is unauthorized.

### Flow 6

Model provider fails.

### Flow 7

User cancels execution.

### Flow 8

Multi-agent execution occurs.

### Flow 9

Multi-model execution occurs.

### Flow 10

Cognitive Mode modifies execution policy.

---

# 51. ACCEPTANCE CRITERIA

## 51.1 Basic Task

Given:

```text
"Explain this concept."
```

The system must:

1. Create a run.
2. Execute a model.
3. Stream response.
4. Complete successfully.
5. Persist the run.

---

## 51.2 Memory Task

Given:

```text
"What did I previously decide about pricing?"
```

The runtime should be capable of:

```text
Model
 ↓
search_memory
 ↓
retrieve relevant memory
 ↓
Model
 ↓
answer
```

if memory is relevant.

---

## 51.3 Tool Task

Given a task requiring a registered tool:

1. Model requests the tool.
2. Runtime validates arguments.
3. Runtime authorizes the call.
4. Tool executes.
5. Result is normalized.
6. Model receives result.
7. Model continues.
8. Final answer is returned.

---

## 51.4 Invalid Tool Call

If arguments fail schema validation:

- tool must not execute,
- error must be represented as a ToolResult/error,
- model may correct the call if policy permits,
- loop limits must still apply.

---

## 51.5 Unauthorized Tool

If authorization fails:

- tool must not execute,
- user should receive an appropriate result,
- the event must be observable,
- sensitive authorization details must not leak.

---

## 51.6 Cancellation

When the user presses Stop:

- cancellation request is sent,
- run transitions appropriately,
- worker stops future execution,
- active operations are aborted where supported,
- UI reflects cancellation.

---

## 51.7 Provider Failure

If the selected provider fails:

- retry if error is retryable,
- fallback if policy permits,
- otherwise fail clearly,
- preserve execution metadata.

---

## 51.8 Cognitive Mode

When Cognitive Mode is disabled:

- no cognitive dependency may block execution.

When enabled:

- cognitive state may influence policy,
- normal AI execution still occurs,
- security and authorization remain unchanged.

---

# 52. NON-FUNCTIONAL REQUIREMENTS

NeuroFlow must be:

### Reliable

Failures should be contained and observable.

### Scalable

API and worker capacity should scale independently.

### Observable

Every important execution stage should be traceable.

### Secure

User/workspace/tool boundaries must be enforced.

### Maintainable

Provider-specific details must remain isolated.

### Testable

Runtime components must have deterministic interfaces.

### Extensible

New models, tools, agents, and cognitive providers should be addable without rewriting the core.

### Responsive

The user should always receive immediate execution feedback.

---

# 53. EXTENSIBILITY REQUIREMENTS

The architecture must make these future additions possible:

## Models

```text
NewModelAdapter
```

without changing the orchestrator.

## Tools

```text
NewTool
```

without changing model gateway logic.

## Agents

```text
NewAgentDefinition
```

without rewriting the runtime.

## Cognitive Providers

```text
NewCognitiveStateProvider
```

without changing standard mode.

## Storage

Memory storage should be replaceable without rewriting agent logic.

---

# 54. IMPLEMENTATION ROADMAP

NeuroFlow is divided into two major implementation phases.

```text
PHASE 1
Core NeuroFlow AI Runtime
        ↓
PHASE 2
AI Code Agent / AI IDE
```

Phase 2 is not a separate AI architecture. It is a specialized coding workspace built directly on the Phase 1 runtime.

---

# 55. PHASE 1 — CORE NEUROFLOW AI RUNTIME

Phase 1 is the existing core implementation defined by this PRD.

## 55.1 Product Goal

Deliver the production AI runtime where users can:

- create conversations,
- submit tasks,
- use Qwen and Groq,
- execute tools,
- retrieve memory,
- use single/multi-agent workflows,
- use single/multi-model execution,
- stream responses,
- inspect execution,
- cancel runs,
- use Standard and Cognitive Mode.

## 55.2 Frontend

Phase 1 includes:

- React + Vite + TypeScript workspace.
- Conversation UI.
- Composer.
- Model selection.
- Standard/Cognitive mode selection.
- Streaming response.
- Run status.
- Cancellation.
- Basic execution inspector.
- Run history.

## 55.3 Backend

Phase 1 includes:

- Node.js + TypeScript.
- Fastify.
- OpenAI-compatible API.
- PostgreSQL.
- Redis.
- BullMQ.
- Run Manager.
- Worker runtime.
- NeuroFlow Orchestrator.
- Context Engine.
- Model Gateway.
- Qwen adapter.
- Groq adapter.
- Tool Runtime.
- Memory Service.
- Evaluation foundation.
- Realtime event system.
- SSE/WebSocket.
- Cancellation.
- Retry/fallback.
- OpenTelemetry.

## 55.4 Phase 1 Agent Runtime

Support:

```text
DIRECT
SINGLE_AGENT
SEQUENTIAL
PARALLEL
SUPERVISOR
EVALUATOR_OPTIMIZER
```

Agent and model strategies remain independent.

## 55.5 Phase 1 Completion Gate

Phase 1 must have a working vertical slice:

```text
React
 ↓
Fastify
 ↓
Run Manager
 ↓
BullMQ
 ↓
Worker
 ↓
Orchestrator
 ↓
Model Gateway
 ↓
Qwen / Groq
 ↓
Realtime Stream
 ↓
React
```

Tool execution, memory, cancellation, persistence, observability, and critical tests must also work.

---

# 56. PHASE 2 — AI CODE AGENT / AI IDE WORKSPACE

Phase 2 introduces a dedicated **AI Code Agent page** inside NeuroFlow.

It is not another dashboard and not a separate chatbot.

It is an AI-native coding environment where the user can connect GitHub, browse a repository, edit code, ask the NeuroFlow agent to modify code, review diffs, run tests, and optionally commit, push, and create pull requests.

Phase 2 must reuse the Phase 1:

- Model Gateway,
- Agent Runtime,
- Tool Runtime,
- Context Engine,
- Memory,
- Evaluation,
- Run Manager,
- Realtime Events,
- Authorization,
- Observability.

---

## 56.1 Phase 2 Core Workflow

```text
Connect GitHub
      ↓
Select Repository
      ↓
Select Branch
      ↓
Open Code Workspace
      ↓
Browse / Edit Code
      ↓
Ask AI Agent
      ↓
Repository Understanding
      ↓
Plan
      ↓
Edit
      ↓
Review Diff
      ↓
Approve / Reject
      ↓
Run Tests
      ↓
Fix Failures
      ↓
Commit
      ↓
Push
      ↓
Optional Pull Request
```

---

## 56.2 Code Agent Page Layout

The page should have four functional regions:

```text
┌─────────────────────────────────────────────────────────────┐
│ Repository / Branch / Workspace                             │
├──────────────┬──────────────────────────────┬───────────────┤
│ Repository   │ Code Editor                  │ AI Agent      │
│ Explorer     │                              │               │
│              │ Monaco                       │ Chat          │
│ Files        │ Tabs                         │ Plan          │
│ Search       │ IntelliSense                 │ Activity      │
│ Git Status   │ Diagnostics                  │ Context       │
│ Branches     │ Diff                         │ Approvals     │
├──────────────┴──────────────────────────────┴───────────────┤
│ Terminal | Problems | Tests | Git Diff | Agent Logs         │
└─────────────────────────────────────────────────────────────┘
```

The code remains the primary artifact. The agent assists it rather than replacing it.

---

## 56.3 GitHub Integration

GitHub must be a first-class integration.

Required flow:

```text
Connect GitHub
 ↓
Authorize
 ↓
Select account / organization
 ↓
Select repository
 ↓
Select branch
 ↓
Create NeuroFlow workspace
 ↓
Synchronize repository
```

The integration should support:

- repository metadata,
- branch metadata,
- file access,
- branch creation,
- Git status,
- commits,
- pushes,
- pull requests,
- pull-request information.

Permissions must be explicit. Repository access must not automatically mean modification permission.

---

## 56.4 Repository Workspace

Each Code Agent workspace must track:

- repository,
- branch,
- current commit,
- working directory,
- synchronization state,
- modified files,
- active run.

Every Code Agent run must be associated with:

```text
User
Workspace
Repository
Branch
Run
```

---

## 56.5 Repository Explorer

The left panel must provide a real repository explorer supporting:

- folder tree,
- file tree,
- file search,
- modified-file indicators,
- Git status,
- branch information,
- repository refresh.

It must reflect the connected repository rather than a static demo.

---

## 56.6 Code Editor

Use a real browser code editor, preferably:

```text
Monaco Editor
```

Required capabilities where supported:

- syntax highlighting,
- language-aware editing,
- line numbers,
- folding,
- autocomplete,
- IntelliSense,
- tabs,
- search/replace,
- multi-cursor,
- diagnostics,
- minimap,
- keyboard shortcuts,
- diff editor,
- inline modifications.

---

## 56.7 Editor Context

The active editor state must be available to the Code Agent.

Context can include:

- active file,
- selected lines,
- surrounding code,
- file path,
- related files,
- user instruction.

Example:

```text
Select lines
 ↓
Ask NeuroFlow
 ↓
"Refactor this"
 ↓
Agent receives selected code + file context
```

---

## 56.8 Context Actions

Provide actions such as:

```text
Explain
Fix
Refactor
Optimize
Write Tests
Find Security Issue
Generate Documentation
```

These must create structured Code Agent requests, not simply copy text into a generic chat.

---

## 56.9 Code Agent

The Code Agent is a specialized NeuroFlow agent.

It must use the existing NeuroFlow runtime.

Responsibilities:

1. Understand repository structure.
2. Search code.
3. Read relevant files.
4. Find references.
5. Understand dependencies.
6. Create a plan.
7. Modify code.
8. Create files.
9. Remove files when authorized.
10. Run tests.
11. Run lint/build.
12. Inspect diffs.
13. Iterate after failures.
14. Summarize changes.
15. Prepare commits.
16. Optionally create pull requests.

---

## 56.10 Code Agent Tool Registry

### Repository Tools

```text
list_files
read_file
search_code
find_symbol
find_references
```

### Editing Tools

```text
create_file
edit_file
rename_file
delete_file
apply_patch
```

### Execution Tools

```text
run_command
run_tests
run_linter
run_build
```

### Git Tools

```text
git_status
git_diff
git_log
create_branch
commit
push
```

### GitHub Tools

```text
get_repository
get_branch
get_pull_requests
get_issues
create_issue
create_pull_request
review_pull_request
```

All these tools must use the existing NeuroFlow Tool Runtime.

---

## 56.11 Code Editing Safety

The preferred editing workflow is:

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

Avoid replacing entire files when a targeted patch is sufficient.

High-impact or destructive changes must require approval according to policy.

---

## 56.12 Diff-First Experience

Every agent modification must be inspectable.

Example:

```text
Modified:
src/auth/login.ts       +12 -4
src/api/client.ts        +8 -2
tests/auth.test.ts       +25 -0
```

The user must be able to open a Monaco diff view and review the changes.

---

## 56.13 Change Approval Modes

Support:

### Suggest Mode

Agent proposes changes only.

### Review Mode

Agent prepares changes and requests approval.

### Auto Mode

Agent may apply low-risk changes within policy.

### Restricted Mode

Selected tools are unavailable.

The selected policy must be associated with the run.

---

## 56.14 Terminal

Provide:

```text
Terminal
Problems
Output
Tests
Git Diff
Agent Logs
```

The terminal must operate against the isolated repository workspace.

---

## 56.15 Code Execution Sandbox

Never execute arbitrary agent commands directly on the main API server.

Required architecture:

```text
Node API
 ↓
Agent Worker
 ↓
Sandbox / Isolated Workspace
 ↓
Repository
 ↓
Command Execution
```

The sandbox should control:

- filesystem access,
- CPU,
- memory,
- network,
- process lifetime,
- commands,
- environment variables,
- secrets.

---

## 56.16 Command Policy

The runtime must distinguish normal development commands from potentially dangerous operations.

Common commands may include:

```text
npm test
npm run lint
npm run build
pytest
go test
cargo test
```

Dangerous operations involving destructive filesystem actions, system changes, unauthorized network access, or secret exposure must be blocked or require explicit approval.

---

## 56.17 Agent Plan and Activity

The UI should show concise execution summaries.

Example:

```text
PLAN

✓ Inspect authentication flow
✓ Locate token refresh logic
◌ Modify refresh handler
◌ Add regression test
◌ Run test suite
```

Activity:

```text
AGENT ACTIVITY

✓ Repository indexed
✓ Search: refreshToken
✓ Read 4 files
✓ Found auth middleware
✓ Generated patch
◌ Running tests
```

These must be real backend execution events and must never expose private chain-of-thought.

---

## 56.18 Agent Context Panel

Show the context currently associated with the run:

```text
CONTEXT

📄 src/auth/login.ts
📄 src/auth/token.ts
📄 src/api/client.ts
🔍 12 references
🌿 branch: neuroflow/agent/auth-fix
```

Users should be able to add/remove context where practical.

---

## 56.19 Git Branch Strategy

For substantial tasks:

```text
main
 ↓
Create agent branch
 ↓
Agent modifies workspace
 ↓
Tests
 ↓
Diff review
 ↓
Commit
 ↓
Push
 ↓
Optional Pull Request
```

Suggested naming:

```text
neuroflow/agent/<short-task-name>
```

The system must respect branch protection and user policy.

---

## 56.20 Git Workflow

Expose:

```text
Create Branch
Commit
Push
Create Pull Request
Refresh
```

Show:

- current branch,
- changed files,
- commit state,
- sync state,
- test state.

---

## 56.21 Commit Workflow

Before commit, show:

- changed files,
- diff summary,
- commit message,
- branch,
- test status.

The user should be able to approve the commit.

---

## 56.22 Pull Request Workflow

The agent may prepare:

- PR title,
- description,
- summary,
- test results,
- changed files,
- relevant run information.

The user retains control unless explicit automation policy permits creation.

---

## 56.23 Code Search

Support, where available:

- text search,
- regex search,
- symbol search,
- reference search,
- file-type filters,
- directory filters.

The agent should use targeted search rather than reading the entire repository.

---

## 56.24 Repository Indexing

For larger repositories, introduce incremental indexing for:

- file paths,
- symbols,
- imports,
- exports,
- references,
- language metadata,
- optional embeddings.

Do not send the entire repository to the model.

---

## 56.25 Code Context Strategy

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
Tool Results
 ↓
Bounded Context
 ↓
Model
```

---

## 56.26 Code Agent Memory

The Code Agent may use NeuroFlow memory for:

- architecture decisions,
- coding conventions,
- preferred libraries,
- repository instructions,
- recurring debugging patterns,
- user preferences.

Memory should be appropriately repository/workspace scoped.

---

## 56.27 Repository Instructions

Support repository-specific instructions, for example:

```text
.neuroflow/instructions.md
```

Instructions may define:

- coding style,
- architecture rules,
- test commands,
- prohibited patterns,
- preferred libraries,
- deployment conventions.

These become controlled Code Agent context.

---

## 56.28 Model Configuration

The Code Agent should expose:

```text
Provider
Model
Reasoning Budget
Temperature where supported
Tool Policy
Agent Strategy
Context Strategy
```

Initial providers:

```text
Groq
Qwen
```

All model calls must continue through the Model Gateway.

---

## 56.29 Model Lab

Introduce a Model Lab with:

```text
Models
Providers
Parameters
Datasets
Fine-tuning
Evaluations
Deployments
```

React must not call provider SDKs directly.

---

## 56.30 Groq Configuration

Allow available Groq models to be configured through:

```text
Provider
 ↓
Model
 ↓
Reasoning Budget
 ↓
Supported Parameters
 ↓
Tools
 ↓
Test Model
```

Unsupported controls must not be presented as functional.

---

## 56.31 Fine-Tuning

Fine-tuning is an optional provider capability.

The UI must represent:

```text
Available
Not Available
Requires Provider Access
Coming Soon
```

Do not assume every user has access.

Fine-tuning must use a provider-independent interface.

---

## 56.32 Fine-Tuning Dataset

Potential sources:

```text
GitHub commits
Pull requests
Code reviews
Accepted patches
Rejected patches
Agent interactions
Test failures
Successful fixes
```

Candidate examples may contain:

```text
Task
Repository Context
Relevant Files
Agent Output
Patch
Tests
User Outcome
Evaluation
```

---

## 56.33 Fine-Tuning Safety

Do not automatically fine-tune from every interaction.

Preferred workflow:

```text
Agent Interaction
 ↓
Outcome
 ↓
User Acceptance / Rejection
 ↓
Evaluation
 ↓
Candidate Example
 ↓
Dataset Review
 ↓
Fine-Tuning
 ↓
Evaluation
 ↓
Deployment
```

Users must control what enters training datasets.

Private repository content must not automatically become training data.

---

## 56.34 Fine-Tuning Job UI

Show:

```text
Base Model
Dataset
Training Configuration
Job Name
Validation
```

During execution:

```text
Status
Progress
Dataset Size
Epoch
Loss where available
Elapsed Time
Logs
Cancel
```

---

## 56.35 Coding Agent Evaluation

Evaluate using objective signals where possible:

- tests passed,
- build passed,
- lint passed,
- patch applied,
- user accepted,
- user rejected,
- regression introduced,
- task completion,
- tool errors,
- execution duration.

---

## 56.36 Agent Replay

Every Code Agent run should be replayable.

Replay must show actual recorded events, such as:

```text
User request
 ↓
Search
 ↓
Files read
 ↓
Patch generated
 ↓
Tests
 ↓
Result
 ↓
Approval
 ↓
Commit
```

Do not regenerate a historical run during replay.

---

## 56.37 Code Agent Run Persistence

Persist:

- repository,
- branch,
- starting commit,
- user request,
- execution plan,
- tool calls,
- files read,
- files modified,
- diffs,
- test results,
- evaluation,
- approvals,
- final status,
- commit/PR references.

---

## 56.38 Phase 2 Realtime Events

Examples:

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

Events must originate from actual backend execution.

---

## 56.39 Phase 2 Security

Requirements:

- repository authorization,
- workspace isolation,
- GitHub credential protection,
- sandboxing,
- command restrictions,
- filesystem restrictions,
- network restrictions,
- secret isolation,
- destructive-action approval,
- audit logging,
- branch protection awareness.

The model must never receive unrestricted GitHub credentials.

---

## 56.40 Phase 2 UX Principles

1. Editor first.
2. Agent second.
3. Diff before destructive action.
4. Realtime execution.
5. User control.
6. Minimal friction.

---

## 56.41 Phase 2 Command Bar

Provide:

```text
Ctrl/Cmd + K
```

with:

```text
Ask NeuroFlow
Explain
Fix
Refactor
Optimize
Write Tests
Find Bug
Find Security Issue
Generate Documentation
Search Repository
```

The command bar inherits current editor context.

---

## 56.42 Phase 2 Acceptance Criteria

Phase 2 is successful when a user can:

1. Connect GitHub.
2. Select a repository.
3. Select a branch.
4. Open the repository in Code Agent.
5. Browse files.
6. Open files in Monaco.
7. Edit code manually.
8. Select code and ask the agent about it.
9. Ask the agent to modify code.
10. Watch real agent events.
11. Review generated diffs.
12. Approve/reject changes.
13. Run tests.
14. See test output.
15. Ask the agent to fix failures.
16. Inspect Git status.
17. Create an agent branch.
18. Commit changes.
19. Push where authorized.
20. Create a PR where authorized.
21. Replay a completed Code Agent run.
22. Configure Qwen/Groq through the Model Gateway.
23. Access Model Lab.
24. Represent fine-tuning availability correctly.
25. Evaluate a coding run.

---

## 56.43 Phase 2 Completion Gate

The complete real-repository loop must work:

```text
GitHub
 ↓
Repository
 ↓
Code Agent
 ↓
Repository Understanding
 ↓
Plan
 ↓
Edit
 ↓
Diff
 ↓
Approval
 ↓
Test
 ↓
Fix
 ↓
Final Diff
 ↓
Commit
 ↓
Push
 ↓
Optional PR
```

The page is not considered complete merely because an editor is displayed.

---

## 56.44 Phase 2 Non-Goals

Do not initially attempt:

- full VS Code parity,
- unrestricted shell access,
- automatic production deployment,
- automatic merging into protected branches,
- automatic training from private repositories,
- automatic fine-tuning from every interaction,
- complete support for every programming language at full IDE capability,
- replacing GitHub's entire product surface.

The objective is a strong AI-native coding workflow.

---

# 57. PHASE 1 DEFINITION OF DONE

NeuroFlow is considered functionally complete for the Phase 1 Core AI Runtime when:

1. A user can open the React workspace.
2. A user can create a conversation.
3. A user can submit a task.
4. The task becomes a durable Run.
5. The run executes through a Node worker.
6. The Model Gateway can use Qwen and Groq.
7. The model can stream output.
8. The system can execute validated tools.
9. The system can retrieve memory.
10. The system can execute at least one agent strategy.
11. Standard Mode works without cognitive state.
12. Cognitive Mode can add cognitive policy.
13. Execution events appear in realtime.
14. The user can cancel a run.
15. Failures are represented clearly.
16. PostgreSQL contains durable runtime state.
17. Redis/BullMQ handles asynchronous work.
18. Observability exists across the execution path.
19. Critical flows have automated tests.
20. The UI feels like an AI workspace rather than a dashboard.

---


# 58. PHASE 2 DEFINITION OF DONE

The Code Agent is complete when:

1. GitHub authentication works.
2. Repository selection works.
3. Branch selection works.
4. Repository synchronization works.
5. Monaco-based editing works.
6. Repository search works.
7. Code Agent tools execute through the NeuroFlow Tool Runtime.
8. Agent-generated patches can be reviewed.
9. Changes can be approved or rejected.
10. Commands execute through the sandbox.
11. Tests can be run.
12. The agent can respond to test failures.
13. Git status and diff work.
14. Agent branches work.
15. Authorized commits work.
16. Authorized pushes work.
17. Authorized pull requests work.
18. Code Agent runs are persisted.
19. Code Agent realtime events work.
20. Agent replay works.
21. Model configuration works through the Model Gateway.
22. Model Lab exists.
23. Fine-tuning availability is represented correctly.
24. Coding-agent evaluation works.
25. Security boundaries are enforced.

Phase 2 is complete only when the end-to-end coding workflow works against a real repository.

---

# 59. FINAL PRODUCT REQUIREMENT

The most important requirement is not the number of features.

The product must provide a coherent execution experience:

```text
                  NEUROFLOW

        ┌─────────────────────────┐
        │        USER TASK        │
        └────────────┬────────────┘
                     ↓
              FAST EXECUTION ACK
                     ↓
            ┌─────────────────┐
            │  AI RUNTIME     │
            │                 │
            │ Router          │
            │ Context         │
            │ Agents          │
            │ Models          │
            │ Tools           │
            │ Memory          │
            │ Evaluation      │
            └────────┬────────┘
                     ↓
              REALTIME EVENTS
                     ↓
             STREAMING RESULT
                     ↓
             FINAL RESPONSE
                     ↓
              OPTIONAL INSPECTOR
```

The user should experience this as one smooth system.

Internally it may contain substantial orchestration complexity.

Externally it should feel coherent, fast, understandable, and controllable.

That separation between **simple user experience** and **powerful execution runtime** is a central product requirement of NeuroFlow.
