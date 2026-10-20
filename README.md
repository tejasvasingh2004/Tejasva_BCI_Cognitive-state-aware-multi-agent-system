# NeuroFlow Documentation — Version 6 Aligned

This folder contains the implementation documentation aligned to the uploaded `prd.md`.

## Source of Truth

`prd.md` is copied unchanged from the uploaded PRD. It is the authoritative product requirement.

When any supporting document conflicts with the PRD, the PRD wins and the supporting document must be corrected.

## Product Roadmap

### Product Phase 1 — Core NeuroFlow AI Runtime

The complete production AI runtime: workspace, conversations, Runs, routing, agents, models, tools, memory, evaluation, realtime execution, cancellation, reliability, Standard Mode and Cognitive Mode.

### Product Phase 2 — AI Code Agent / AI IDE Workspace

A specialized AI-native coding environment built directly on Product Phase 1. It adds GitHub, repository/branch workspaces, Monaco, Code Agent tools, code context, patches/diffs, approvals, sandbox execution, tests/repair, Git/GitHub workflows, replay, coding evaluation and Model Lab.

## Critical Alignment Rule

Phase 2 is **not** a second runtime. The Phase 1 runtime is deliberately extended so that code-specific capabilities fit into the same Run, Agent, Model, Tool, Context, Memory, Evaluation, Realtime, Authorization and Observability infrastructure.

## Current Status

Product Phase 1 is complete. Product Phase 2 is complete and verified against a real repository up
to the local commit; live push and pull requests on github.com need a token with write access.
On top of both: provider rate budgets and circuit breakers, plan-based limits and quotas, separate
fair queues, Plan Review, Tasks and Workspace Settings, CI, a marketing site and deployment
configs for Vercel and Railway.

**`STATUS.md` is the one-page record of everything built so far** — read it first.

## Repository Layout

```text
apps/
  api/        Fastify API (Run Manager, auth, rate limits, routes)
  worker/     BullMQ workers (runs, workspace jobs, evaluations)
  web/        React product UI (AI workspace, Code workspace, Model Lab)
  site/       Marketing site (pre-rendered static pages)
packages/
  contracts/  shared types and schemas      orchestrator/  router, strategies, agent runtime
  models/     Model Gateway + providers      tools/         Tool Runtime and core tools
  code/       Code Agent tools, Git, sandbox memory/        memory service
  cognitive/  Cognitive Mode                 bus/           Redis queues, events, rate limits
  db/         PostgreSQL access + CLI        observability/ OpenTelemetry + logging
infra/        migrations, Dockerfiles, nginx
backend/, workload_classifier/   EEG workload classifier sidecar for Cognitive Mode (Python)
```

## Quick Start

See `SETUP.md`. In short: `pnpm install`, `pnpm infra:up`, `pnpm dev` (API :8080, web :5173),
and `pnpm --filter @neuroflow/site dev` for the marketing site (:5180).

## Files

- `prd.md` — authoritative Product Requirements Document; unchanged
- `STATUS.md` — current state of the repository: what is built, verified, deployed and open
- `architecture.md` — production architecture for both product phases
- `system-design.md` — implementation-level system contracts for both product phases
- `brain-dump.md` — product/engineering mental model for both phases
- `progress.md` — internal implementation workstreams plus Product Phase 1/2 completion tracking
- `docs/decisions.md` — implementation decisions, resolved contradictions and trade-offs
- `TODO.md` — remaining system-design and infrastructure work (load balancing, HA, observability)
- `SETUP.md` — local setup, tests and deployment
- `claude.md` — master implementation prompt for both phases
- `repository_analysis.md`, `README_old.md` — the original Python/Next.js BCI research prototype

## Terminology

Do not confuse **Product Phase 1/2** with the numbered internal implementation workstreams in `progress.md`.

## Completion Philosophy

Phase 1 completion means the general runtime works end-to-end. Phase 2 completion means the real-repository coding loop works end-to-end:

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
