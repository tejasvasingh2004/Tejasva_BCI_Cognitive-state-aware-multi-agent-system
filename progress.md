# NeuroFlow — Implementation Progress
Version 4 · updated 2026-10-01

Legend: `[x]` done and tested · `[~]` partial (see note) · `[ ]` not started · `[-]` deferred by design (documented as future)

## Status

All MVP requirements from `prd.md`, `architecture.md`, `system-design.md` and `claude.md` are
implemented and tested. A requirement-by-requirement audit of the four documents against the code
(October 2026) found remaining gaps; they were closed in this pass (see `docs/decisions.md`,
"Second pass").

Verified end to end with a real local Qwen model (Ollama) and the EEG classifier sidecar.

Tests: unit + integration (real Postgres/Redis/BullMQ) across all packages, 11 Playwright E2E flows.

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

## Remaining (needs input or is post-MVP)

1. Live Groq verification — add a `GROQ_API_KEY`.
2. Web search — add a Tavily/Brave key or a SearXNG URL to enable the tool.
3. OIDC/SSO, pgvector memory, interaction-based cognitive signal, mid-graph resume (post-MVP).
