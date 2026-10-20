# Changelog

Notable changes to NeuroFlow. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project does not publish versioned releases yet, so entries are grouped by date.

## 2026-10-20

### Added
- Open-source project files: license, contributing guide, code of conduct, security policy, issue
  and pull request templates, editor config.
- `docs/STATUS.md` — one-page record of the current state of the repository.
- `docs/DEPLOYMENT.md` — hosting guide, including the worker and sandbox on a VM.

### Changed
- Documentation moved into `docs/`; the README was rewritten as a project overview.

## 2026-10-18

### Added
- Deployment configuration: Vercel for the marketing site and web app, Railway (Nixpacks) for the
  API.

### Fixed
- Runtime dependencies declared for the API and worker builds.

## 2026-10-11

### Added
- Plan Review: approve, edit, revise or reject the Code Agent's plan before it changes the repository.
- Tasks page: every Code Agent run with status, duration, diff stats, tests, branch, cost and pull request.
- Workspace Settings: approval mode, default model, Plan Review default, project commands, sandbox
  image and repository instructions.
- Marketing site with home, download, pricing, docs and changelog pages, with a 3D glass design.
- Shared provider rate budgets (Redis token buckets), a circuit breaker per provider, workspace
  plans with rate limits and daily token quotas, separate queues with per-tenant fair scheduling.
- Continuous integration: typecheck, lint, unit, integration, end-to-end tests and image builds.

### Fixed
- Workspace settings accept partial command overrides.

## 2026-10 (earlier)

### Added
- Product Phase 2: GitHub connection, code workspaces, Monaco editor, Code Agent with 27 tools,
  reviewed patches, Docker sandbox, test-and-repair loop, agent branches, draft pull requests,
  replay and Model Lab.
- Product Phase 1: run manager, queues and workers, adaptive router with six execution strategies,
  Model Gateway (Groq, Qwen), Tool Runtime, memory, evaluation, realtime events, Cognitive Mode,
  OpenAI-compatible API, authentication, audit and OpenTelemetry.

### Changed
- The original Python/Next.js BCI prototype was rebuilt as a TypeScript monorepo; the EEG workload
  classifier remains as the optional Cognitive Mode sidecar.
