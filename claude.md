# NeuroFlow — Master Claude Implementation Prompt
Version 6 — Phase 1 + Phase 2 Aligned

You are implementing NeuroFlow as a serious production-oriented AI workspace.

The authoritative product contract is `prd.md`. Keep `prd.md` unchanged unless the user explicitly asks to modify it.

There are exactly two **product phases** in the PRD:

1. Product Phase 1 — Core NeuroFlow AI Runtime
2. Product Phase 2 — AI Code Agent / AI IDE Workspace

Any numbered implementation phases in `progress.md` are internal workstreams and must not be mistaken for the product roadmap.

The central implementation rule is:

```text
Product Phase 1 = general runtime foundation
Product Phase 2 = coding workspace specialization of that runtime
```

Never build a second backend architecture for Phase 2.

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

# Product Phase 1 — Foundation Contract

Before calling Phase 1 complete, ensure the generic runtime is capable of carrying Phase 2 without architectural replacement:

- Runs can carry optional workspace/repository context.
- Context Engine can accept files, selections and repository metadata.
- Tool Runtime is extensible to repository, filesystem, command and GitHub capabilities.
- Authorization supports workspace, repository and destructive-action boundaries.
- Event infrastructure accepts code-specific event types.
- Persistence can store run artifacts, approvals and external references.
- Evaluation can consume tests/build/lint and user-outcome signals.
- Model configuration remains entirely behind Model Gateway.
- Standard Mode remains fully functional without Cognitive Mode.

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

# Product Phase 1 Completion Gate

Do not move to declaring Phase 2 complete until Product Phase 1 has its full vertical slice and reliability/security foundations.

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

Tool execution, memory, cancellation, persistence, observability and critical tests must also work.

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

# Unified Product Goal

The finished system must feel like one product:

```text
Phase 1 AI Workspace
        │
        └── shared NeuroFlow Runtime ──┐
                                       │
Phase 2 Code Workspace ────────────────┘
```

A user can perform ordinary AI tasks using Product Phase 1 and coding tasks using Product Phase 2 without the two experiences becoming separate runtimes.

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

---

# Product Phase 2 — Mandatory AI Code Agent Implementation

The PRD is the authoritative product specification. Implement its Phase 2 exactly as an extension of Phase 1, not as a separate AI system.

## Phase 2 Goal

Build a dedicated AI Code Agent / AI IDE workspace where a user can connect GitHub, select a repository and branch, browse/edit code in Monaco, ask the specialized Code Agent to understand and modify code, review diffs, run tests, repair failures, and optionally commit, push and create pull requests.

## Required Workspace

Implement:

```text
Repository / Branch / Workspace
├── Repository Explorer
├── Monaco Editor
├── AI Agent
└── Terminal | Problems | Tests | Git Diff | Agent Logs
```

The editor is the primary artifact. Do not turn Phase 2 into a generic analytics dashboard.

## Required GitHub Flow

```text
Connect GitHub
 ↓
Authorize
 ↓
Select account/organization
 ↓
Select repository
 ↓
Select branch
 ↓
Create/synchronize workspace
```

Keep credentials server-side and enforce repository/workspace permissions.

## Required Code Agent Capabilities

The Code Agent must:

1. Understand repository structure.
2. Search code.
3. Read relevant files.
4. Find references/symbols.
5. Understand dependencies.
6. Create a plan.
7. Generate targeted patches.
8. Create/remove/rename files according to policy.
9. Run tests/lint/build.
10. Inspect failures.
11. Iterate within bounded budgets.
12. Summarize changes.
13. Prepare commits.
14. Optionally create PRs.

## Required Tool Registry

Implement the exact Phase 2 tool families from the PRD:

```text
Repository: list_files, read_file, search_code, find_symbol, find_references
Editing: create_file, edit_file, rename_file, delete_file, apply_patch
Execution: run_command, run_tests, run_linter, run_build
Git: git_status, git_diff, git_log, create_branch, commit, push
GitHub: get_repository, get_branch, get_pull_requests, get_issues,
        create_issue, create_pull_request, review_pull_request
```

All tools go through Tool Registry → schema validation → authorization → risk/approval → execution → normalized result.

## Safe Editing

Never allow blind model mutation.

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

Support Suggest, Review, Auto and Restricted modes.

## Sandbox

Never execute arbitrary agent commands on the API server.

```text
Node API
 ↓
Agent Worker
 ↓
Sandbox / Isolated Workspace
 ↓
Repository
 ↓
Command
```

Control filesystem, CPU, memory, network, process lifetime, commands, environment and secrets.

## Code Context

Use active editor context plus targeted repository retrieval. Support `.neuroflow/instructions.md`. Do not send the entire repository to the model.

## Git Workflow

Use agent branches such as:

```text
neuroflow/agent/<short-task-name>
```

Require appropriate authorization before commit/push/PR operations.

## Model Lab

Implement the Phase 2 Model Lab surfaces:

```text
Models
Providers
Parameters
Datasets
Fine-tuning
Evaluations
Deployments
```

Qwen and Groq remain behind the Model Gateway. Never call provider SDKs directly from React.

Fine-tuning is provider-dependent. Never imply functionality when the provider does not support it. Never automatically train on private repository content.

## Replay

Persist actual Code Agent events and artifacts. Replay must read stored history; it must never rerun a historical task.

## Phase 2 Events

Implement real backend events:

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

## Phase 2 Completion Gate

Do not declare Phase 2 complete until this works against a real repository:

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

## Non-Negotiable Phase 2 Non-Goals

Do not initially attempt full VS Code parity, unrestricted shell access, automatic production deployment, automatic merging into protected branches, automatic training from private repositories, automatic fine-tuning from every interaction, full IDE support for every language, or replacement of GitHub.
