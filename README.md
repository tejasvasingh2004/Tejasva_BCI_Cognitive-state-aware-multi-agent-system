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

## Files

- `prd.md` — authoritative Product Requirements Document; unchanged
- `architecture.md` — production architecture for both product phases
- `system-design.md` — implementation-level system contracts for both product phases
- `brain-dump.md` — product/engineering mental model for both phases
- `progress.md` — internal implementation workstreams plus Product Phase 1/2 completion tracking
- `claude.md` — master implementation prompt for both phases

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
