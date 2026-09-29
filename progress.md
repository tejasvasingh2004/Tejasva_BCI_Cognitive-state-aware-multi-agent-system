# NeuroFlow — Implementation Progress
Version 4 · updated 2026-09-30

Legend: `[x]` done and tested · `[~]` partial (see note) · `[ ]` not started

## Status

The first vertical slice is working end-to-end and verified against a real local Qwen model:
React workspace → Fastify API → durable run → Redis/BullMQ → worker → orchestrator → Model
Gateway → Qwen → realtime SSE events → React. Cognitive Mode was verified end-to-end with the
EEG classifier sidecar.

Tests: 93 unit/integration tests (real Postgres/Redis for integration) + 7 Playwright E2E flows.

---

## Phase 0 — Foundation

- [x] TypeScript monorepo (pnpm workspaces)
- [x] Turborepo pipeline (`dev`, `build`, `typecheck`, `test`)
- [~] TypeScript project references — packages ship TS source consumed via bundler resolution (tsup/Vite/Vitest); no `tsc -b` graph needed
- [x] ESLint (typescript-eslint) / Prettier
- [x] React/Vite app · Fastify API · worker app · shared contracts package
- [x] Docker Compose for PostgreSQL + Redis (+ `app` and `bci` profiles), production Dockerfiles

## Phase 1 — API

- [x] Authentication boundary (hashed scoped API keys, signed session cookies, dev login)
- [~] Production identity provider (OIDC/SSO) — not yet; `AUTH_MODE=production` accepts API keys only
- [x] Request validation (Zod) and API error contract
- [x] `/v1/chat/completions` (stream + non-stream) and `/v1/models`
- [x] `/v1/runs`, `/v1/runs/:id`, cancel, approvals, SSE events, WebSocket control stream
- [x] Run persistence, idempotency keys
- [x] `/health`, `/ready`

## Phase 2 — Execution Runtime

- [x] Run Manager (admission control, transactional creation, enqueue)
- [x] BullMQ queue · worker · orchestrator · execution plan
- [x] Direct and single-agent strategies
- [x] Cancellation (UI → API → Redis control + durable flag → AbortSignal → model/tool)
- [~] Checkpointing — completed side-effecting tool calls are not re-run on recovery; runs restart from the beginning (no mid-graph resume)

## Phase 3 — Model Gateway

- [x] Provider interface · Qwen adapter (Ollama / DashScope) · Groq adapter
- [x] Streaming normalization (SSE, tool-call assembly, `<think>`/reasoning stripping)
- [x] Reasoning budget abstraction (off/low/medium/high → provider controls)
- [x] Attempt / first-token / idle timeouts · bounded retries · cross-provider fallback
- [~] Groq verified with a mock provider only — needs a `GROQ_API_KEY` for a live check

## Phase 4 — Tools

- [x] Tool Registry · JSON Schema contracts (from Zod) · Zod validation
- [x] Authorization (principal scopes + run tool policy) · risk levels · approval (fail-closed)
- [x] Timeouts · retries only for side-effect-free tools · normalized, bounded ToolResult
- [x] Tool loop limits (per-agent iterations, per-run tool calls, run model-call budget)
- [x] Built-ins: calculator (safe parser), get_current_time
- [ ] Web search tool (needs a search provider key)

## Phase 5 — Memory

- [x] Memory data model (Postgres full-text) · Memory Service · bounded, scoped retrieval
- [x] `search_memory`, `save_memory`, `delete_memory` (approval) tools
- [x] Memory UI and user memory controls
- [ ] Semantic retrieval (pgvector) — post-MVP

## Phase 6 — Agents

- [x] Agent definitions (assistant, researcher, analyst, writer, supervisor, critic, refiner)
- [x] Single · sequential · parallel · supervisor · evaluator/optimizer
- [x] Independent model assignment (tier-based multi-model, never provider-hardcoded)
- [~] Workspace-defined custom agents — schema/repo exist, no UI/API yet

## Phase 7 — Cognitive Mode

- [x] CognitiveStateProvider (stored/manual, BCI HTTP, chained)
- [x] Cognitive policy (ported LOW/MEDIUM/HIGH policies) · Standard/Cognitive separation
- [x] Cognitive UI (mode toggle, workload self-report, BCI sample) · UI density adaptation
- [x] Policy tests · EEG classifier sidecar (`backend/app/bci_service.py`)

## Phase 8 — Frontend

- [x] Workspace shell · conversation UI · composer · streaming response
- [x] Execution status/timeline from real events · inspector
- [x] Model selector · strategy selector · reasoning budget · tools toggle
- [x] Tool approval UI · cognitive controls · memory manager · keyboard shortcuts
- [~] Tablet/mobile layouts — responsive basics only (sidebar hides, inspector overlays)
- [ ] Dark theme

## Phase 9 — Realtime

- [x] Event model (typed, persisted, ordered) · SSE · WebSocket control stream
- [x] Cancellation, tool, agent, model, evaluation, memory, cognitive events
- [x] Reconnect/resume (Last-Event-ID / `?after=`)

## Phase 10 — Reliability

- [x] Idempotency · provider fallback · worker retry (crash/shutdown recovery)
- [~] Dead-letter handling — failed jobs retained 24h + stale-run reconciler; no DLQ UI
- [x] Graceful shutdown · backpressure (active-run and backlog limits) · rate limits (Redis)
- [x] Resource budgets (model calls, duration, tool calls, iterations, context tokens)

## Phase 11 — Observability

- [x] OpenTelemetry SDK bootstrap (OTLP, auto-instrumentation), run-scoped spans
- [x] Metrics: queue latency, run duration, model latency/first token, retries, fallbacks, tokens, tool latency, evaluations
- [x] Structured logs with secret redaction · run-level correlation (trace context API → worker)
- [~] Verified with no-op exporter only — not yet exercised against a live collector (Jaeger/Tempo)

## Phase 12 — Testing

- [x] Unit tests · API integration tests · tool validation tests · gateway tests
- [x] Worker/runtime tests (via the vertical-slice suite) · streaming · cancellation · failure/recovery
- [x] Playwright E2E (7 flows)

---

## Definition of Done (MVP)

| Criterion | Status |
| --- | --- |
| Standard Mode works end-to-end | ✅ verified with real Qwen |
| Cognitive Mode works as an optional policy layer | ✅ verified with EEG sidecar |
| Qwen and Groq routed through one Model Gateway | ✅ (Groq: mock-verified) |
| Single/multi-agent and single/multi-model are independent | ✅ |
| Tools are schema validated and authorized | ✅ |
| Memory is a bounded capability | ✅ |
| Long-running work runs in workers | ✅ |
| Realtime events are real backend events | ✅ |
| UI feels like a workspace, not a dashboard | ✅ |
| OpenAI-compatible API works | ✅ |
| PostgreSQL and Redis are reliable | ✅ |
| Observability is available | 🟡 instrumented; live collector check pending |
| Critical flows have automated tests | ✅ |

## Next up

1. Live Groq verification (add `GROQ_API_KEY`).
2. OpenTelemetry against a local collector (Jaeger) and a small latency dashboard.
3. Production identity provider (OIDC) for the workspace.
4. Conversation summaries for long histories; pgvector semantic memory.
5. Custom workspace agents (API + UI) and a web search tool.
