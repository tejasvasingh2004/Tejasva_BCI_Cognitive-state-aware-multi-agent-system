# NeuroFlow

An AI workspace and AI execution runtime. You ask; NeuroFlow acknowledges instantly, plans the
smallest reliable execution graph, runs models / agents / tools / memory in a background worker,
streams real execution events and the answer back, and lets you inspect exactly what happened —
without ever exposing private chain-of-thought.

Optional **Cognitive Mode** adds a cognitive-state signal (manual self-report or the EEG workload
classifier in `workload_classifier/`) that shapes presentation and strategy — never permissions.

```text
React + Vite workspace ──REST/SSE/WS──▶ Fastify API ──▶ Run Manager ──▶ Redis/BullMQ
                                                                           │
                              PostgreSQL ◀── durable state ──  Worker ◀────┘
                                                                  │
                                                     NeuroFlow Orchestrator
                                   ┌──────────────┬───────────────┼───────────────┐
                               Router /     Agent runtime     Tool runtime    Cognitive
                            Context engine  (6 strategies)   (+ memory tools)  policy
                                                  │
                                            Model Gateway ──▶ Qwen (Ollama / DashScope)
                                                          └─▶ Groq
```

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, shadcn-style Radix components, Framer Motion, TanStack Query, Zustand |
| Backend | Node.js 22, TypeScript, Fastify 5, Zod 4 |
| Runtime | PostgreSQL 17, Redis 7, BullMQ, Docker, OpenTelemetry |
| Models | Qwen (local Ollama or DashScope) and Groq, behind one Model Gateway |
| Cognitive signal | Python EEG workload classifier (STEW, PCA + SVM) as an optional sidecar |

Next.js is intentionally not used: the backend is a long-running AI runtime (queues, workers,
SSE/WebSocket, tool execution) and the React app and Node runtime deploy independently.

## Repository layout

```text
apps/
  web/            React workspace (Vite)            → static site, talks only to the API
  api/            Fastify HTTP/SSE/WebSocket API    → auth, validation, Run Manager, OpenAI-compatible API
  worker/         BullMQ worker                     → executes runs through the orchestrator
packages/
  contracts/      Zod schemas + types shared by every layer (runs, plans, events, tools…)
  models/         Model Gateway: Qwen + Groq adapters, retries, fallback, timeouts, reasoning budget
  orchestrator/   router, context engine, agents, 6 execution strategies, evaluation
  tools/          tool registry + validated/authorized tool runtime, built-in tools
  memory/         PostgreSQL memory service + search/save/delete memory tools
  cognitive/      cognitive-state providers (stored, BCI) and policy derivation
  bus/            BullMQ run queue, ordered run events (persist → publish), control channel
  db/             PostgreSQL pool, migrations runner, repositories
  observability/  OpenTelemetry bootstrap, spans, metrics, redacting logger
infra/
  migrations/     SQL migrations
  docker/         Dockerfiles (api/worker, web, bci) and nginx config
backend/          Python: EEG classifier sidecar (app/bci_service.py) + legacy research runtime
workload_classifier/  EEG preprocessing, features and trained model (STEW)
```

Agent/tool/memory/context/evaluation live as modules of `packages/orchestrator`, `tools` and
`memory` rather than as separate packages; they can be split out when a second consumer appears.

## Quick start (local development)

Prerequisites: Node 22+, pnpm 9 (`corepack enable`), Docker, and a model provider —
[Ollama](https://ollama.com) with a Qwen model (`ollama pull qwen3:8b`) and/or a `GROQ_API_KEY`.

```bash
cp .env.example .env            # adjust QWEN_MODELS / GROQ_API_KEY as needed
pnpm install
pnpm infra:up                   # PostgreSQL (localhost:5433) + Redis (localhost:6380)
pnpm dev                        # api :8080, worker, web :5173 (migrations run automatically)
```

Open http://localhost:5173. In `AUTH_MODE=dev` the workspace signs you in automatically as a
local developer; `DEV_API_KEY` is registered for API clients.

### Full stack in Docker

```bash
SESSION_SECRET=$(openssl rand -hex 32) docker compose --profile app up -d --build
# web → http://localhost:5173 (nginx proxies /api to the API)
docker compose --profile bci up -d bci      # optional EEG cognitive-state service (:8000)
```

## Using the API

Every client — the workspace, scripts, OpenAI SDKs — goes through the same runtime.

```bash
# NeuroFlow runs
curl -s localhost:8080/v1/runs -H "authorization: Bearer $DEV_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What did I decide about pricing?"}]}'
curl -N localhost:8080/v1/runs/<run-id>/events -H "authorization: Bearer $DEV_API_KEY"   # SSE

# OpenAI-compatible
curl -s localhost:8080/v1/chat/completions -H "authorization: Bearer $DEV_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"neuroflow-auto","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible (stream / non-stream); `model` = `neuroflow-auto` or a model ref |
| `GET /v1/models` | OpenAI-format model list with availability |
| `POST /v1/runs` · `GET /v1/runs/:id` | create a run (supports `Idempotency-Key`) · run + execution details |
| `GET /v1/runs/:id/events` | SSE execution events, resumable with `Last-Event-ID` / `?after=` |
| `GET /v1/runs/:id/stream` | WebSocket: events out, `cancel` / `approve` control in |
| `POST /v1/runs/:id/cancel` · `POST /v1/runs/:id/approvals` | cancellation · tool approval decisions |
| `/v1/conversations[/:id[/runs]]` | conversations, history, workspace composer runs |
| `/v1/memories[/search]` | user-managed memory |
| `/v1/cognitive/state` · `/v1/cognitive/sample` | Cognitive Mode state (manual / BCI sample) |
| `GET /health` · `GET /ready` | liveness · readiness (database, Redis, model providers) |

Errors always use `{"error":{"code","message","retryable?","details?"}}`.

## How a run executes

1. **API** authenticates (API key or session cookie), validates with Zod, applies admission control
   (per-workspace active runs, queue backlog), persists the conversation/messages/run in one
   transaction, emits `run.created`/`run.queued` and enqueues the job — then returns.
2. **Worker** claims the run, emits `run.started`, and wires cancellation (Redis control channel +
   durable flag) into an `AbortSignal` that reaches the model stream and tools.
3. **Orchestrator** optionally resolves cognitive policy, then the **router** produces an
   `ExecutionPlan`: task class, agent strategy (`direct`, `single_agent`, `sequential`, `parallel`,
   `supervisor`, `evaluator_optimizer`), model strategy (single/multi, chosen independently by
   capability tier — never by hardcoded provider), tool/context policy, reasoning budget, budgets.
4. **Agents** call the **Model Gateway**; tool calls go through the **Tool Runtime**
   (name → JSON Schema/Zod validation → scope + run-policy authorization → approval → timeout →
   bounded `ToolResult`). Memory is just tools (`search_memory`, `save_memory`, `delete_memory`).
5. **Evaluation**: always a zero-cost heuristic check; a model evaluator only when the plan says so.
6. Every step is a real, persisted event streamed to the UI; the answer the user saw is exactly
   what is persisted.

## Testing

```bash
pnpm test                    # unit + integration (integration uses Postgres/Redis from infra:up)
pnpm test:e2e                # Playwright: full stack (API + worker) with a mock provider
```

- Unit: contracts, gateway (streaming, reasoning hiding, retries, fallback, timeouts, cancellation),
  tools (validation, authorization, approval, bounding), router/context, cognitive policy, UI reducer.
- Integration (real Postgres + Redis + BullMQ): repositories, event bus, memory, and the full
  vertical slice — API → queue → worker → orchestrator → gateway → SSE, including cancellation,
  provider fallback, OpenAI compatibility, idempotency, workspace isolation, worker crash recovery.
- E2E (browser): ask/stream/persist, timeline + inspector, memory, tools, cancel, provider failure,
  Cognitive Mode.

## Documentation

- `architecture.md` — architecture and invariants
- `system-design.md` — implementation-level design
- `prd.md` — product requirements
- `brain-dump.md` — product/architecture reasoning
- `docs/decisions.md` — implementation decisions and resolved doc contradictions
- `progress.md` — implementation status
- `claude.md` — implementation brief
