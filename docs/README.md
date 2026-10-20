# NeuroFlow documentation

Start with **[STATUS.md](STATUS.md)** for what is built today.

## Product and design

| Document | Purpose |
| --- | --- |
| [prd.md](prd.md) | Product Requirements Document — the authoritative product contract |
| [architecture.md](architecture.md) | Production architecture for both product phases |
| [system-design.md](system-design.md) | Implementation-level contracts: requests, queues, router, gateway, tools, events, persistence |
| [decisions.md](decisions.md) | Design decisions, resolved contradictions and trade-offs |
| [brain-dump.md](brain-dump.md) | Product and engineering mental model |

When a supporting document conflicts with the PRD, the PRD wins and the supporting document is
corrected.

## Progress and planning

| Document | Purpose |
| --- | --- |
| [STATUS.md](STATUS.md) | One-page current state: features, verification, deployment, open items |
| [progress.md](progress.md) | Requirement-by-requirement checklist |
| [ROADMAP.md](ROADMAP.md) | Remaining infrastructure and scaling work |
| [../CHANGELOG.md](../CHANGELOG.md) | Notable changes by date |

## Guides

| Document | Purpose |
| --- | --- |
| [SETUP.md](SETUP.md) | Local development, plans and limits, tests |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Hosting the site, web app, API, worker and sandbox |

## Product phases

- **Product Phase 1 — Core NeuroFlow AI Runtime:** workspace, conversations, runs, routing, agents,
  models, tools, memory, evaluation, realtime execution, cancellation, reliability, Standard Mode
  and Cognitive Mode.
- **Product Phase 2 — AI Code Agent / AI IDE Workspace:** GitHub, repository and branch workspaces,
  Monaco, Code Agent tools, code context, patches and diffs, approvals, sandbox execution,
  tests and repair, Git and GitHub workflows, replay, coding evaluation and Model Lab.

Phase 2 is **not** a second runtime: code-specific capabilities extend the same run, agent, model,
tool, context, memory, evaluation, realtime, authorization and observability infrastructure. Do not
confuse the two product phases with the numbered internal workstreams in `progress.md`.

## Legacy

The original Python/FastAPI + Next.js BCI research prototype, kept for reference:
[legacy/prototype-readme.md](legacy/prototype-readme.md) and
[legacy/prototype-analysis.md](legacy/prototype-analysis.md).
