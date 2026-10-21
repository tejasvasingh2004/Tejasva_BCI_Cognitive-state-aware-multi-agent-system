# NeuroFlow — Implementation Progress
Version 6 · updated 2026-10-20 · one-page summary in [`STATUS.md`](STATUS.md)

Legend: `[x]` done and tested · `[~]` partial (see note) · `[ ]` not started · `[-]` deferred by design (documented as future)

## Status

The numbered "Phase N" sections below are internal implementation workstreams of **Product
Phase 1** (core runtime). **Product Phase 2** (AI Code Agent / AI IDE workspace) has its own
section at the end; it is a specialization of the same runtime, not a second backend.

Product Phase 1: all MVP requirements from `prd.md`, `architecture.md`, `system-design.md` and `claude.md` are
implemented and tested. A requirement-by-requirement audit of the four documents against the code
(October 2026) found remaining gaps; they were closed in this pass (see `decisions.md`,
"Second pass").

Verified end to end with a real local Qwen model (Ollama) and the EEG classifier sidecar.

Tests: ~220 unit tests across 13 packages, 48 integration tests (real Postgres/Redis/BullMQ/Git/Docker),
16 Playwright E2E flows (11 Phase 1, 4 Phase 2, 1 usage). CI runs all of them on every push.

---

## Phase 0 — Foundation

- [x] TypeScript monorepo (pnpm workspaces) · Turborepo pipeline · ESLint/Prettier
- [~] TypeScript project references — packages ship TS source consumed via bundler resolution (tsup/Vite/Vitest); no `tsc -b` graph needed
- [x] React/Vite app · Fastify API · worker · shared contracts
- [x] Docker Compose (infra, `app`, `bci` profiles) and production Dockerfiles

## Phase 1 — API

- [x] Authentication: email/password accounts (scrypt), signed session cookies, hashed scoped API keys, dev login (dev mode only)
- [x] Workspace authorization: membership re-checked per request; API key scopes ∩ owner's current role
- [x] Brute-force protection for credentials; rate limits; per-user/per-workspace active-run limits
- [x] API key management (create once / list / revoke) · workspace settings · custom agents · audit log
- [x] Request validation (Zod) and one error contract
- [x] `/v1/chat/completions` (stream + non-stream, client tools, response_format) and `/v1/models`
- [x] `/v1/runs`, details, cancel, approvals, SSE events, WebSocket control
- [x] Run persistence, idempotency keys, `/health`, `/ready`
- [-] OIDC / SSO identity provider (password accounts + API keys cover MVP)

## Phase 2 — Execution Runtime

- [x] Run Manager (admission control, transactional creation, priority queueing)
- [x] BullMQ queue · worker · orchestrator · execution plan
- [x] Cancellation end to end (UI → API → Redis + durable flag → AbortSignal → model/tool)
- [~] Checkpointing — agent/model/tool calls are persisted and completed side-effecting tool calls are never repeated; recovered runs restart rather than resuming mid-graph

## Phase 3 — Model Gateway

- [x] Provider interface · Qwen (Ollama / DashScope) · Groq
- [x] Streaming normalisation, reasoning hiding, reasoning budget (off/low/medium/high)
- [x] Timeouts · bounded retries · cross-provider fallback · per-provider concurrency limits
- [x] Usage + estimated cost (built-in Groq prices, free local models, `MODEL_PRICING`)
- [~] Groq verified against a mock provider only — needs a `GROQ_API_KEY` for a live check

## Phase 4 — Tools

- [x] Registry · JSON Schema contracts · Zod validation · authorization · risk levels · approval
- [x] Timeouts · retries only for side-effect-free tools · bounded ToolResult
- [x] Loop limits: per-agent iterations, per-agent and per-run tool calls, model-call/time/cost budgets
- [x] Built-ins: calculator, get_current_time, memory tools, web_search (Tavily / Brave / SearXNG, when configured)
- [ ] Workspace file / retrieval tools (PRD lists them as potential; richer ecosystem is post-MVP)

## Phase 5 — Memory

- [x] Memory service (Postgres full text), bounded scoped retrieval, memory tools, memory UI
- [x] Retention: per-memory TTL + workspace retention policy, purge job, audit
- [x] Source metadata surfaced in events and the inspector
- [-] Semantic retrieval (pgvector) — post-MVP

## Phase 6 — Agents

- [x] Agent definitions with capabilities and output contracts
- [x] Direct · single · sequential · parallel · supervisor (review + one follow-up round) · evaluator/optimizer
- [x] Independent model assignment (tier based, never provider hardcoded)
- [x] Workspace-defined custom agents (API + Settings UI), runnable by name and available to the supervisor

## Phase 7 — Cognitive Mode

- [x] Providers (stored/manual, BCI HTTP, chained) · policy · Standard/Cognitive separation
- [x] Policy shapes context density, response density, task chunking, strategy cap, evaluation,
      model preference, UI density and notification intensity
- [x] EEG classifier sidecar (`backend/app/bci_service.py`) verified end to end
- [-] Interaction-derived cognitive provider — "possible future" in the PRD

## Phase 8 — Frontend

- [x] Workspace shell · conversation · composer · streaming · status from real events
- [x] Composer: mode, model, strategy, reasoning budget, per-tool selection, agent picker
- [x] Inspector: run timestamps, strategy, execution graph, models (latency, cost), agents, tools,
      memory sources, evaluation, reliability (retries, fallbacks, timeouts, budgets)
- [x] Approvals · memory manager · Settings (appearance, notifications, workspace, agents, API keys, audit)
- [x] Sign-in screen (production) · dark theme · mobile drawer layout · keyboard shortcuts
- [x] Completion notifications scaled by cognitive notification intensity

## Phase 9 — Realtime

- [x] Typed persisted ordered events · SSE with resume · WebSocket control stream

## Phase 10 — Reliability

- [x] Idempotency · provider fallback · worker crash/shutdown recovery · stale-run reconciler
- [x] Graceful shutdown · backpressure · rate limits · budgets (model calls, tool calls, time, cost, context)
- [~] Dead-letter handling — failed jobs retained 24h + reconciler; no DLQ UI

## Phase 11 — Observability

- [x] OpenTelemetry traces: HTTP → run.create → run.process → run.orchestrate → router.plan →
      agent.run → model.call → tool.execute → evaluation.run (+ Postgres/Redis auto-instrumentation)
- [x] Metrics: queue latency, run duration, model latency/first token, retries, fallbacks, tokens,
      cost, tool latency, evaluations, auth failures
- [x] Redacting structured logs · trace context API → worker · verified against Jaeger
- [x] Audit trail of security-relevant actions

## Phase 12 — Testing

- [x] Unit: contracts, gateway (cost, concurrency), tools (web search), router/context, budgets,
      evaluation checks, client tools, agents, summaries, cognitive policy, UI reducer, config guard
- [x] Integration: repositories, bus, memory retention, full vertical slice, security
      (login, throttling, key scopes/membership, approvals owner, admin-only routes), settings,
      agents, summaries, OpenAI tools / response_format
- [x] E2E (Playwright, 11 flows): ask/stream/persist, timeline + inspector, memory, tools, invalid
      tool arguments, unauthorized tool, multi-agent + multi-model, cancellation, provider failure,
      Cognitive Mode, settings/custom agent/theme

---

## Definition of Done (MVP)

| Criterion | Status |
| --- | --- |
| Standard Mode works end to end | ✅ real Qwen |
| Cognitive Mode is an optional policy layer | ✅ EEG sidecar verified |
| Qwen and Groq behind one Model Gateway | ✅ (Groq live check needs a key) |
| Single/multi-agent and single/multi-model independent | ✅ |
| Tools schema-validated and authorized | ✅ |
| Memory is a bounded capability | ✅ (with retention) |
| Long-running work runs in workers | ✅ |
| Realtime events are real backend events | ✅ |
| Workspace UI, not a dashboard | ✅ |
| OpenAI-compatible API | ✅ (incl. client tools) |
| PostgreSQL and Redis reliable | ✅ |
| Observability available | ✅ verified with Jaeger |
| Security: auth, authorization, rate limits, audit | ✅ |
| Critical flows have automated tests | ✅ |

---

## Product Phase 2 — AI Code Agent / AI IDE Workspace

A code run is an ordinary NeuroFlow run with `workspaceContext`; the same API, Run Manager,
BullMQ queue, worker, orchestrator, Model Gateway, Tool Runtime, events and persistence carry it.

- [x] GitHub connection: fine-grained token or OAuth App (single-use state), tokens AES-256-GCM
      encrypted at rest, never returned to the browser or given to the model
- [x] Account/organization → repository → branch selection; repository access ≠ push permission
- [x] Code workspaces: isolated checkout per workspace, cloned/synchronised in the worker
      (fetch + fast-forward only when clean), status events
- [x] Repository understanding: project detection (node/python/go/rust), repository map,
      `.neuroflow/instructions.md`, active file/selection/pinned files as context (never the
      whole repository)
- [x] Tool registry, all 27 PRD tools: repository (list_files, read_file, search_code, find_symbol,
      find_references), editing (create/edit/rename/delete_file, apply_patch), execution
      (run_command/tests/linter/build), Git (status, diff, log, create_branch, commit, push),
      GitHub (get_repository/branch/pull_requests/issues, create_issue, create_pull_request,
      review_pull_request) — schema validation → authorization → risk/approval → execution
- [x] Safe editing: understand → patch → validate (`git apply --check`) → diff → approval policy →
      apply; Suggest / Review / Auto / Restricted modes; high-impact changes always ask
- [x] Sandbox: Docker, no network (except installs), CPU/memory/pids limits, read-only root,
      dropped capabilities, no host env/secrets, timeouts; command policy deny-list
- [x] Code Agent: plan (`agent.plan.created`) → explore → patch → validation (tests) → bounded
      repair loop → summary; budgets for duration, model and tool calls
- [x] Git workflow: commits only on `neuroflow/agent/<task>` branches, push limited to agent
      branches and to credentials with push permission, PRs opened as drafts, never merged
- [x] Phase 2 events (code.run.created … code.run.completed) emitted by the backend
- [x] Replay from stored events and artifacts (never re-executes); coding evaluation signals
- [x] Model Lab: Models, Providers, Parameters (AI workspace / Code Agent scopes), Datasets
      (explicit user action only, reviewed-only export), Fine-tuning (provider status stated
      honestly; no provider currently supports it through NeuroFlow), Evaluations (worker),
      Deployments (`deployment/<name>`)
- [x] Workspace UI: top bar (repository/branch/sync/approval mode), Explorer (Files, Search, Git,
      Branches), Monaco (tabs, IntelliSense + diagnostics for TS/JS/JSON/CSS/HTML, HEAD diff,
      Ctrl+S), AI Agent (Chat, Plan, Activity, Context, Approvals with diff review), bottom panel
      (Terminal, Problems, Tests, Git Diff with commit/push/PR, Agent Logs), Ctrl+K command bar,
      Replay view; dark mode
- [x] Plan Review: opt-in per task or per workspace; the agent proposes a plan and waits; the user
      approves it as is, edits the steps, asks for a revision (max 3) or rejects it
      (`plan.review_required` / `plan.approved` / `plan.rejected`, `POST /v1/code/runs/:id/plan`)
- [x] Tasks page: every run in a workspace with status, duration, diff stats, tests, agent branch,
      tokens, cost and PR; filter, search, open and replay
- [x] Usage page: plan limits, daily quota meter, 7 / 30 / 90-day totals, tokens / cost / runs per
      day with a table view, breakdowns by source, model and repository
      (`GET /v1/workspace/usage/history`)
- [x] Workspace Settings: approval mode, default model, Plan Review default, project commands,
      sandbox image, `.neuroflow/instructions.md` editor, archive
- [x] Tests: code package (real Git + Docker), orchestrator code runs, API integration (mock GitHub
      API + real Git remote + Docker), Playwright E2E for the full browser flow and Model Lab

### Phase 2 completion gate

| Step | Verified |
| --- | --- |
| GitHub → repository → branch | ✅ against a mock GitHub REST API (integration + E2E) |
| Workspace clone / sync | ✅ real Git remote |
| Repository understanding → plan → edit → diff → approval | ✅ |
| Test → fix (bounded repair loop) | ✅ real Docker sandbox |
| Final diff → commit → push | ✅ real Git push to a remote |
| Optional PR | ✅ against the mock GitHub API |
| **Same flow on github.com with a real repository** | ⏳ verified on a real repository with Groq up to the local commit; push and PR need a token with Contents + Pull requests write |

## Scalability and reliability foundation

- [x] Shared provider budgets: tokens/requests per minute per API key and provider concurrency in
      Redis (atomic token buckets, expiring leases), key pools, provider retry-after honoured by
      every worker, `model.throttled` events
- [x] Circuit breaker per provider (closed / open / half-open with backoff), visible in Model Lab
- [x] Workspace plans (free / pro / team / enterprise) with per-tenant, per-route HTTP rate limits,
      RateLimit headers and Retry-After, admission caps and daily token quotas, usage endpoint
- [x] Separate queues (runs / workspace / evals) with priorities and per-tenant fair scheduling
- [ ] Load-balanced deployment (2+ API servers and workers behind Nginx) and k6 load test
- [ ] Workspace service (checkouts not tied to one host) and isolated sandbox pool
- [x] CI: GitHub Actions for typecheck, lint, unit, integration (Postgres + Redis services), E2E
      and image builds
- [ ] Dashboards and alerts

## Website

- [x] Marketing site (`apps/site`, pre-rendered static pages): home, download, pricing, docs,
      changelog generated from Git history; links into the app
- [x] Landing page with CSS 3D depth: floating glass panels, orbs, ribbons and terrazzo driven by
      pointer and scroll, 3D hero, demo stage, feature bento with live visuals, pinned scroll story,
      interactive Cognitive Mode orb, tilt cards; reduced motion respected
- [x] Icy blue glass palette (sky canvas, frosted panels, cyan edges, cobalt accents, navy text)
- [ ] Desktop download builds and payments (later phase)

## Deployment

- [x] Vercel configs for `apps/site` (static, clean URLs) and `apps/web` (SPA rewrites)
- [x] Railway/Nixpacks config for the API (Node 22, pnpm 9), runtime dependencies declared for API
      and worker
- [x] Docker Compose (`infra`, `app`, `bci` profiles) and Dockerfiles for self-hosting
- [~] Worker host with a Docker daemon for the sandbox in the hosted deployment — one-command
      setup script (`infra/scripts/setup-worker-vm.sh`); the VM itself is not provisioned yet
- [ ] Continuous deployment gated on CI, and staging environment

## Remaining (needs input or is post-MVP)

1. Live push/PR on github.com — grant the fine-grained token Contents and Pull requests write.
2. Live Groq: configured and used for the real-repository run (done).
3. Web search — add a Tavily/Brave key or a SearXNG URL to enable the tool.
4. OIDC/SSO, pgvector memory, interaction-based cognitive signal, mid-graph resume (post-MVP).
5. Phase 2 non-goals stay out of scope: VS Code parity, unrestricted shell, automatic deployment,
   merging into protected branches, automatic training or fine-tuning.
