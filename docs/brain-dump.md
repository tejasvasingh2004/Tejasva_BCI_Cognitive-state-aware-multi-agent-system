# NeuroFlow — Brain Dump
Version 4

## Core Idea

NeuroFlow is an AI workspace + execution runtime.

It is not a chatbot wrapper.
It is not a normal dashboard.
It is not a thin UI around one model.

The desired experience is:

```text
ASK
 ↓
EXECUTE
 ↓
WATCH
 ↓
STREAM
 ↓
INSPECT
```

Think Cursor/Traycer-style interaction, but with a generalized multi-model, multi-agent runtime and optional cognitive adaptation.

---

## Stack Decision

Use:

```text
React
Vite
TypeScript
Tailwind
shadcn/ui
Framer Motion

Node.js
TypeScript
Fastify
Zod

PostgreSQL
Redis
BullMQ
Docker
OpenTelemetry
```

Do not use Next.js as the core backend framework.

Reason:

NeuroFlow's backend is an AI runtime with workers, queues, tool execution, model gateways, long-running runs, WebSockets/SSE, and independent scaling.

The React application should remain independently deployable from the Node runtime.

---

## The Core Runtime

```text
React
 ↓
Fastify
 ↓
Run Manager
 ↓
Redis/BullMQ
 ↓
Worker
 ↓
Orchestrator
 ↓
Router
 ↓
Context
 ↓
Agent Runtime
 ↓
Model Gateway
 ↓
Qwen / Groq
 ↓
Tool Runtime
 ↓
Evaluation
 ↓
Stream
```

---

## OpenAI Compatibility

Expose:

```text
POST /v1/chat/completions
```

This is compatibility, not identity.

NeuroFlow can expose an OpenAI-compatible surface while internally using Qwen, Groq, or future models.

---

## Important Correction: thinking=true

Do not make:

```text
thinking=true
```

a universal NeuroFlow API concept.

Instead:

```text
reasoningBudget:
  off
  low
  medium
  high
```

The Model Gateway maps this to whatever each provider supports.

---

## Important Correction: AJV

AJV is not mandatory.

The important requirement is:

```text
JSON Schema
 ↓
Validation
 ↓
Authorization
 ↓
Execution
```

Since this runtime is TypeScript-first, Zod is a natural implementation choice.

JSON Schema remains useful as the canonical tool contract.

---

## Important Correction: Memory

Do not hardcode:

```text
Need to search memory
```

as a pipeline stage.

Instead:

```text
Model decides tool is needed
 ↓
search_memory
 ↓
validate
 ↓
authorize
 ↓
execute
 ↓
return bounded memory
 ↓
model resumes
```

Memory is a capability.

---

## Agent and Model Independence

Never assume:

```text
Agent 1 = Qwen
Agent 2 = Groq
```

Instead:

```text
Agent topology
      ×
Model topology
```

Any valid combination should work.

---

## Cognitive Mode

Cognitive state is not a second AI system.

It is a policy signal.

```text
Cognitive State
 ↓
Policy
 ↓
Normal Runtime
```

Standard Mode should be complete even when cognitive state is absent.

---

## UI Philosophy

Avoid:

```text
Admin Dashboard
Analytics Cards
Huge Navigation
Static Tables
```

Prefer:

```text
Workspace
Conversation
Composer
Live execution
Streaming
Inspector
```

The main UI should feel fluid.

---

## Advanced UI

Default:

```text
User asks:
"Analyze these files and find the problem."

UI:

Running...
Analyzing...
Using workspace context...
Completed
```

Advanced inspector:

```text
Run
Mode: Standard
Strategy: Supervisor
Models: Qwen + Groq
Agents: 3
Tools: 4
Memory: 2 results
Evaluation: passed
Latency: ...
```

Never show private chain-of-thought.

---

## Production Rules

- No fake progress.
- No infinite tool loops.
- No unbounded context.
- No unvalidated tool calls.
- No unauthorized tool execution.
- No long-running work inside API handlers.
- No hardcoded provider-specific behavior throughout the codebase.
- No frontend dependency on provider SDKs.
- No hidden coupling between React and AI runtime.
- No premature microservices.

Start as a modular monorepo, split services when scale actually requires it.

---

## Monorepo Shape

```text
neuroflow/
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

  infra/
    docker/
    migrations/

  docs/
```

---

## Execution Philosophy

Use the smallest reliable execution graph.

Simple task:

```text
Direct → Model → Answer
```

Tool task:

```text
Agent → Tool → Model → Answer
```

Complex task:

```text
Supervisor
 ├── Research
 ├── Analysis
 └── Evaluation
       ↓
    Finalize
```

Do not turn every task into a multi-agent workflow.

---

## Scaling Philosophy

Start modular.

Scale horizontally:

```text
API replicas
Worker replicas
Redis
PostgreSQL
Model Gateway
```

Later, if justified:

```text
Kafka/NATS
Kubernetes
Dedicated tool service
Dedicated model service
```

Do not introduce distributed infrastructure just for architectural appearance.
