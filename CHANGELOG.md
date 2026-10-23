# Changelog

Notable changes to NeuroFlow. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project does not publish versioned releases yet, so entries are grouped by date.

## 2026-10-24

### Added
- Hosted open-weight models through Together AI, Fireworks AI and OpenRouter, with server keys
  (`TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `OPENROUTER_API_KEY`) or each workspace's own key.

## 2026-10-23

### Added
- Spending limits: daily and monthly dollar limits per workspace with an alert threshold (Usage →
  Spending limits, `/v1/workspace/budget`), and a monthly budget per workspace provider key.
  New runs are refused at a workspace limit and running tasks stop before their next model call; a
  key over budget is skipped and the run falls back to other models. Crossing a threshold or a limit
  is recorded in the audit log.

## 2026-10-22

### Added
- Anthropic (Claude Opus, Sonnet and Haiku 5.5), OpenAI and Google Gemini providers, served with a
  workspace's own key or a server key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`).
  Claude's tool loops keep its reasoning between tool calls without ever showing it.
- Bring your own key: workspaces store their own model provider keys (Settings → Model providers,
  `/v1/provider-keys`). Keys are checked with the provider, envelope-encrypted, shown only as a
  4-character hint, and used by the workspace's runs in their own rate-limit scope.
  `PLATFORM_MODEL_KEYS=disabled` runs models only with workspace keys.
- Error tracking for the API and worker (`SENTRY_DSN`): server errors, crashes and actionable run
  failures, with credentials redacted.
- `GET /status` health summary (database, Redis, live workers, queue age, model providers) and an
  `Uptime` GitHub Actions workflow that opens and closes an incident issue.

### Fixed
- The Model Lab end-to-end test no longer fails intermittently: it located the model field by a
  label whose text changed once the model list loaded.
- Models now know which model they are: the system instructions name the model and provider the
  router chose (an open-weight GPT-OSS model had claimed to be "GPT-4-turbo").

### Added (earlier the same day)
- Usage page (`/usage`): plan limits, today's token quota, 7 / 30 / 90-day totals, daily tokens, cost
  and runs, and breakdowns by source, model and repository.
- `GET /v1/workspace/usage/history` usage aggregates.
- `infra/scripts/setup-worker-vm.sh`: one-command setup of the worker and sandbox on a VM.
- `infra/loadtest/`: N API replicas and M workers behind an nginx load balancer, a mock model
  provider and a k6 load test. 2 APIs + 2 workers vs 1 + 1 at 100 reads/s + 10 runs/s: every run
  admitted (vs 86 %), run p50 2.6 s (vs 20.5 s), requests split 50/50.

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
