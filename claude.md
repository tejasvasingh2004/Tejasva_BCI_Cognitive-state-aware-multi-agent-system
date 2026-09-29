# NeuroFlow — Master Claude Implementation Prompt
Version 4

You are implementing NeuroFlow as a serious production-oriented AI workspace.

Before changing code:

1. Read:
   - architecture.md
   - system-design.md
   - prd.md
   - brain-dump.md
   - progress.md

2. Inspect the existing repository.
3. Preserve useful existing work.
4. Identify contradictions before implementation.
5. Implement incrementally.
6. Keep the runtime modular.

---

# Non-Negotiable Stack

Frontend:

```text
React
TypeScript
Vite
Tailwind
shadcn/ui
Framer Motion
TanStack Query
Zustand
```

Backend:

```text
Node.js
TypeScript
Fastify
Zod
```

Infrastructure:

```text
PostgreSQL
Redis
BullMQ
Docker
OpenTelemetry
```

Models:

```text
Qwen
Groq
```

Do NOT introduce Next.js as the core backend framework.

The React frontend and Node backend must be independently deployable.

---

# Product Goal

Build a Cursor/Traycer-like AI workspace.

It must not look or behave like a generic admin dashboard.

Primary interaction:

```text
ASK
 ↓
EXECUTE
 ↓
LIVE PROGRESS
 ↓
STREAM
 ↓
RESULT
 ↓
OPTIONAL INSPECTOR
```

---

# Architecture

Use:

```text
React + Vite
      ↓
Node + Fastify
      ↓
Run Manager
      ↓
Redis + BullMQ
      ↓
Worker
      ↓
NeuroFlow Orchestrator
      ↓
Context Engine
      ↓
Agent Runtime
      ↓
Model Gateway
      ├── Qwen
      └── Groq
      ↓
Tool Runtime
      ↓
Evaluation
      ↓
Realtime Events
      ↓
React
```

---

# OpenAI-Compatible API

Implement:

```text
POST /v1/chat/completions
```

It is an interoperability boundary.

It does not mean OpenAI models must be used.

Normalize compatible requests into the internal RunRequest model.

---

# Standard Mode

Standard Mode is the default and must be a complete production AI runtime.

It must support:

- model routing
- agents
- multiple models
- tools
- memory
- evaluation
- streaming
- realtime events
- cancellation
- reliability controls

Do NOT implement Standard Mode as a simple chatbot.

---

# Cognitive Mode

Cognitive Mode is explicit opt-in.

Add:

```text
Cognitive State
 ↓
Cognitive Policy
 ↓
Normal AI Runtime
```

Do not create a completely separate AI architecture.

---

# Agent/Model Independence

Support:

```text
single agent + single model
single agent + multi model
multi agent + single model
multi agent + multi model
```

Do not hardcode:

```text
agent 1 → Qwen
agent 2 → Groq
```

The router should select independently.

---

# Execution Strategies

Implement:

```text
DIRECT
SINGLE_AGENT
SEQUENTIAL
PARALLEL
SUPERVISOR
EVALUATOR_OPTIMIZER
```

Use the smallest reliable strategy.

Do not make every request multi-agent.

---

# Model Gateway

Create a provider-independent interface.

It must handle:

- model selection
- provider selection
- streaming
- timeout
- retry
- fallback
- usage metadata
- reasoning budget

Use:

```text
reasoningBudget:
  off
  low
  medium
  high
```

Do NOT create a universal:

```text
thinking=true
```

parameter.

---

# Tool Runtime

Every tool must have:

```text
name
description
JSON Schema
risk level
authorization requirements
approval requirement
timeout
```

Execution:

```text
Model Tool Call
 ↓
Tool Registry
 ↓
Schema Validation
 ↓
Authorization
 ↓
Approval if required
 ↓
Execute
 ↓
Normalize ToolResult
 ↓
Append Result
 ↓
Resume Model
```

Zod may implement validation in TypeScript.

JSON Schema remains the interoperable contract.

Do not execute raw model-generated tool arguments without validation.

---

# Memory

Memory is a tool/capability.

Do not hardcode:

```text
Need to search memory
```

Instead:

```text
Model
 ↓
search_memory tool
 ↓
validate
 ↓
authorize
 ↓
Memory Service
 ↓
bounded result
 ↓
Model
```

Never inject unlimited memory into the prompt.

---

# Realtime

Implement real backend-generated execution events.

Examples:

```text
run.created
router.selected
agent.started
agent.completed
model.started
model.completed
tool.started
tool.completed
evaluation.completed
response.delta
run.completed
run.failed
```

The frontend must not fake execution progress.

Use SSE for simple streaming.

Use WebSocket when bidirectional control is needed.

---

# UI

Build a polished workspace.

Prioritize:

- conversation
- composer
- live execution
- streaming
- execution status
- optional inspector

Avoid:

- dashboard cards
- unnecessary tables
- excessive navigation
- decorative architecture diagrams in the main workflow

Advanced inspector can show:

```text
mode
strategy
models
agents
tools
memory
evaluation
latency
retries
```

Never expose private chain-of-thought.

---

# Backend Structure

Prefer:

```text
apps/
  web/
  api/
  worker/

packages/
  contracts/
  orchestrator/
  agents/
  models/
  tools/
  memory/
  context/
  cognitive/
  evaluation/
  observability/
  ui/
```

Use clear boundaries.

Do not create premature microservices.

---

# Reliability

Implement:

- bounded retries
- timeouts
- cancellation
- idempotency
- provider fallback
- tool loop limits
- context limits
- queue backpressure
- graceful shutdown
- worker recovery

Long-running tasks must execute in workers.

Do not block Fastify request handlers with long model/tool loops.

---

# Security

Implement:

- authentication
- workspace authorization
- tool authorization
- API key handling
- rate limits
- input validation
- secret protection
- audit events
- approval for consequential actions

---

# Observability

Use OpenTelemetry.

Trace:

```text
HTTP
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

Record latency, usage, retries, errors and queue time.

Never log secrets or hidden reasoning.

---

# Implementation Order

1. Inspect repository.
2. Establish TypeScript monorepo structure.
3. Create shared contracts.
4. Build Fastify API.
5. Build Run Manager.
6. Add PostgreSQL persistence.
7. Add Redis/BullMQ.
8. Build worker.
9. Build Model Gateway.
10. Integrate Qwen.
11. Integrate Groq.
12. Build Tool Registry/Runtime.
13. Build memory.
14. Build agent strategies.
15. Build evaluation.
16. Build realtime event stream.
17. Build React workspace.
18. Build inspector.
19. Add Cognitive Mode.
20. Add reliability/observability.
21. Add tests.
22. Run end-to-end validation.

---

# Important Engineering Rule

Do not merely create interfaces or placeholder files and call the architecture complete.

For each major feature, create:

- implementation
- tests
- error handling
- integration path
- observable behavior

If a dependency is unavailable, create a clean adapter boundary and document the exact integration point.

---

# Final Goal

At completion, NeuroFlow should feel like:

```text
A smooth AI operating workspace
        +
A production-grade model/agent runtime
        +
Optional cognitive adaptation
```

not:

```text
A chatbot
+
A dashboard
+
A collection of demo agents
```
