# NeuroFlow — Product Requirements Document
Version 4 — React + Node.js + TypeScript

## 1. Product Vision

NeuroFlow is a smooth AI workspace where users can ask complex tasks and watch them execute in real time.

It should feel closer to Cursor/Traycer than a traditional dashboard.

The user should not need to understand:

- agents
- model routing
- queues
- tools
- memory
- evaluators

unless they want to inspect them.

---

## 2. Modes

### Standard Mode

Default.

Characteristics:

- no cognitive-state dependency
- full AI runtime
- model routing
- agent execution
- tools
- memory
- evaluation
- realtime streaming

### Cognitive Mode

Explicitly enabled.

Adds:

- cognitive-state input
- cognitive policy
- adaptive presentation
- optional execution adaptation

It must retain the complete Standard runtime underneath.

---

## 3. Model Selection

Users may choose:

### Single Model

One model executes the task.

### Multi Model

Multiple models may participate based on routing policy.

Initial model ecosystem:

- Qwen
- Groq

The UI should allow simple selection without exposing unnecessary provider complexity.

---

## 4. Agent Selection

Users may choose:

- Auto
- Single Agent
- Multi-Agent

Advanced execution strategies may include:

- sequential
- parallel
- supervisor
- evaluator/optimizer

The default should be automatic.

---

## 5. Core User Flow

```text
Open NeuroFlow
 ↓
Write task
 ↓
Send
 ↓
Immediate execution state
 ↓
Live progress
 ↓
Streaming answer
 ↓
Completed result
```

Optional:

```text
Open Inspector
 ↓
View execution metadata
```

---

## 6. Execution Inspector

Advanced users may see:

```text
Mode
Task class
Execution strategy
Model(s)
Agent(s)
Tool calls
Memory retrieval
Evaluation
Latency
Retries
Fallbacks
```

Never show private chain-of-thought.

---

## 7. Tool Calling

Tools must be first-class capabilities.

Examples:

- search memory
- workspace retrieval
- web/search integrations when configured
- file operations
- custom user tools

Every tool requires:

- schema
- authorization
- timeout
- error handling
- risk level
- optional approval

---

## 8. Memory

Users should be able to benefit from persistent memory without manually managing prompts.

The system should:

- store useful memories
- retrieve relevant memories
- bound retrieved context
- show memory usage in inspector
- allow user controls over memory

---

## 9. Realtime Experience

The UI must receive actual execution events.

Example:

```text
Thinking / Planning
Running research
Using memory
Calling tool
Analyzing result
Evaluating
Writing response
```

These labels are user-facing summaries of runtime state, not hidden reasoning.

---

## 10. Performance Requirements

Targets should be measurable rather than simulated.

Initial goals:

- fast acknowledgement after submission
- streaming begins as soon as meaningful output is available
- no unnecessary blocking of the API process
- cancellation should propagate quickly
- worker execution should be horizontally scalable

Exact SLOs should be established after baseline measurements.

---

## 11. Reliability

The system must handle:

- provider timeout
- provider error
- tool timeout
- malformed tool arguments
- invalid model output
- worker restart
- Redis interruption
- duplicate job delivery
- cancellation
- partial execution

Retries must be bounded and idempotency-aware.

---

## 12. Security

Required:

- authentication
- authorization
- workspace isolation
- API key management
- tool permissions
- approval for consequential actions
- rate limiting
- input validation
- secret protection
- audit events

---

## 13. MVP

MVP is complete when:

### Frontend

- React + Vite + TypeScript workspace works.
- User can create conversations.
- User can send tasks.
- Streaming responses work.
- Execution state is visible.
- Inspector is available.

### Backend

- Node.js + Fastify API works.
- OpenAI-compatible `/v1/chat/completions` works.
- Runs are persisted.
- BullMQ worker executes runs.
- Model Gateway supports Qwen and Groq.
- Tool Runtime works.
- Memory tool works.
- Standard Mode works.
- Cognitive Mode integration point works.

### Infrastructure

- PostgreSQL works.
- Redis works.
- Docker Compose works.
- OpenTelemetry is integrated.
- Tests cover critical runtime paths.

---

## 14. Non-Goals for MVP

Do not prematurely build:

- Kubernetes complexity
- distributed event streaming infrastructure
- dozens of agents
- dozens of providers
- advanced autonomous behavior without evaluation
- decorative dashboards
- fake execution timelines
- exposed chain-of-thought

---

## 15. Product Principle

NeuroFlow should make complexity available without forcing complexity on the user.

Simple on the surface.
Powerful underneath.
Inspectable when needed.
Realtime by default.
Production-oriented from the beginning.
