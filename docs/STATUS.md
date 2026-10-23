# NeuroFlow — Current State of the Repository

Living record of what is built, how it fits together, how it is verified and what is left.
Updated 2026-10-23 · branch `master` (includes the merged `v2` work). Hosting guide: [DEPLOYMENT.md](DEPLOYMENT.md).

Keep this file current: when a feature lands, add it here in the same commit. Requirements live in
[`prd.md`](prd.md); detailed checklists in [`progress.md`](progress.md); design rationale in
[`decisions.md`](decisions.md); open infrastructure work in [`ROADMAP.md`](ROADMAP.md).

---

## 1. At a glance

| | |
| --- | --- |
| Product | AI workspace (Product Phase 1) + AI Code Agent / AI IDE (Product Phase 2) on **one** runtime |
| Stack | React 19 · Vite 7 · Tailwind 4 · TanStack Query · Zustand · Monaco — Node 22 · Fastify 5 · Zod 4 · BullMQ — PostgreSQL · Redis · Docker · OpenTelemetry |
| Models | Groq (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` in preview, …), local Qwen through Ollama, and Anthropic (Claude), OpenAI and Google Gemini with platform or workspace keys, all behind the Model Gateway; the model's own identity is stated in its instructions |
| Apps | `apps/api` (Fastify), `apps/worker` (BullMQ), `apps/web` (product UI), `apps/site` (marketing site) |
| Packages | `contracts`, `orchestrator`, `models`, `tools`, `memory`, `cognitive`, `code`, `bus`, `db`, `observability`, `sdk` (+ Python SDK in `sdks/python`) |
| API | 106 routes, including `POST /v1/chat/completions` (OpenAI-compatible) |
| Database | 13 migrations (`infra/migrations/0001` … `0013`) |
| Tests | ~220 unit tests across 13 packages, 48 integration tests (real Postgres, Redis, BullMQ, Git, Docker), 16 Playwright E2E flows |
| CI | GitHub Actions: typecheck · lint · unit · integration · E2E · app and image builds (`.github/workflows/ci.yml`) |
| Deploy | `apps/site` and `apps/web` on Vercel (`vercel.json` in each), API on Railway (`nixpacks.toml`) |

Code size (TypeScript, approximate): web 10.3k lines · api 4.1k · code 3.7k · orchestrator 3.3k ·
site 2.3k · db 2.2k · models 2.2k · contracts 1.6k · tools 1.2k · bus 0.9k · worker 0.9k.

---

## 2. Request path

```text
React (apps/web)
  → Fastify API: auth → plan rate limit → admission/quota → Run Manager
  → BullMQ (neuroflow-runs | neuroflow-workspace | neuroflow-evals)
  → Worker: per-tenant fairness gate → NeuroFlow Orchestrator
      → Context Engine → Router (strategy, agents, models) → Agent Runtime
      → Model Gateway (rate budgets, circuit breaker, retry, fallback) → Groq / Qwen
      → Tool Runtime (schema → authorization → approval → execute → normalized result)
      → Evaluation
  → Redis event bus → SSE / WebSocket → React (live progress, streamed answer, inspector)
PostgreSQL holds runs, events, artifacts, approvals, memory, workspaces and audit records.
```

---

## 3. Product Phase 1 — Core AI runtime (complete)

- **Runs** — every request (UI, API key, OpenAI-compatible) becomes a `RunRequest`, persisted and
  queued; idempotency keys, cancellation, bounded retries and timeouts.
- **Execution strategies** — DIRECT, SINGLE_AGENT, SEQUENTIAL, PARALLEL, SUPERVISOR,
  EVALUATOR_OPTIMIZER; the router picks the smallest reliable one. Agents and models are chosen
  independently (single/multi agent × single/multi model).
- **Model Gateway** — provider-independent streaming, `reasoningBudget` (off/low/medium/high),
  timeouts (total, first token, idle), retries, fallbacks, usage and cost metadata.
- **Tool Runtime** — JSON Schema contract (Zod in TypeScript), risk levels, authorization,
  approval for consequential actions, loop limits, normalized results.
- **Memory** — a `search_memory` tool with bounded results; never injected wholesale.
- **Cognitive Mode** — opt-in: cognitive state (manual, stored or the EEG classifier sidecar in
  `backend/` + `workload_classifier/`) → policy → the normal runtime. Standard Mode works without it.
- **Realtime** — backend-generated events (`run.created`, `router.selected`, `agent.*`, `model.*`,
  `tool.*`, `evaluation.completed`, `response.delta`, `run.completed` / `run.failed`, …); the UI
  never fakes progress.
- **Security** — sessions and API keys with scopes, workspace authorization, tool authorization,
  audit events, secrets encrypted at rest (AES-256-GCM), input validation.
- **Observability** — OpenTelemetry spans HTTP → run → router → agent → model → tool → evaluation;
  latency, usage, retries, queue time; no secrets or hidden reasoning in logs.
- **UI** — conversation + composer + live execution + streaming + optional inspector (mode,
  strategy, models, agents, tools, memory, evaluation, latency, retries); dark and light themes.

## 4. Product Phase 2 — AI Code Agent / AI IDE (complete except live push on github.com)

- **GitHub** — fine-grained token or OAuth App; owner → repository → branch selection; tokens
  encrypted, never sent to the browser or the model; repository access is separate from push rights.
- **Code workspaces** — isolated checkout per workspace, cloned and synchronised in the worker.
- **Code context** — project detection (node/python/go/rust), repository map,
  `.neuroflow/instructions.md`, active file, selection and pinned files; never the whole repository.
- **27 tools** — repository (list_files, read_file, search_code, find_symbol, find_references),
  editing (create/edit/rename/delete_file, apply_patch), execution (run_command, run_tests,
  run_linter, run_build), Git (git_status, git_diff, git_log, create_branch, commit, push), GitHub
  (get_repository, get_branch, get_pull_requests, get_issues, create_issue, create_pull_request,
  review_pull_request).
- **Safe editing** — understand → patch → `git apply --check` → diff → approval policy → apply;
  Suggest / Review / Auto / Restricted modes; high-impact changes always ask.
- **Sandbox** — Docker with no network (except installs), CPU/memory/pid limits, read-only root,
  dropped capabilities, no host secrets, timeouts, command deny-list. Never on the API server.
- **Agent loop** — plan → explore → patch → tests → bounded repair loop → summary, with budgets
  for duration, model calls and tool calls.
- **Plan Review** — opt-in per task or per workspace: the agent proposes a plan and waits; the user
  approves it, edits the steps, asks for a revision (max 3) or rejects it
  (`plan.review_required` / `plan.approved` / `plan.rejected`, `POST /v1/code/runs/:id/plan`).
- **Git workflow** — commits only on `neuroflow/agent/<task>` branches, push needs authorization,
  pull requests open as drafts, nothing is ever merged.
- **Replay** — reads stored events and artifacts; never re-executes.
- **Model Lab** — Models, Providers, Parameters, Datasets (explicit user action only), Fine-tuning
  (provider support stated honestly: none today), Evaluations (worker), Deployments
  (`deployment/<name>`).
- **Workspace UI** — Explorer (Files, Search, Git, Branches), Monaco (tabs, IntelliSense for
  TS/JS/JSON/CSS/HTML, HEAD diff), AI Agent panel (Chat, Plan, Activity, Context, Approvals),
  bottom panel (Terminal, Problems, Tests, Git Diff with commit/push/PR, Agent Logs), Ctrl+K command
  bar, Replay view.
- **Tasks page** (`/code/:id/tasks`) — every run with status, duration, diff stats, tests, agent
  branch, tokens, cost and PR; filter, search, open, replay.
- **Usage page** (`/usage`) — plan and limits, today's token quota meter, totals for 7 / 30 / 90
  days, tokens / cost / runs per day (with a table view), and breakdowns by source (chat, code,
  API), model (average and p95 latency) and repository. Backed by
  `GET /v1/workspace/usage/history`, aggregated from recorded runs and model calls (migration 0008).
- **Workspace Settings** (`/code/:id/settings`) — approval mode, default model, Plan Review default,
  project command overrides, sandbox image, instructions editor, archive. Stored in
  `code_workspaces.settings` (migration 0007).

Real-repository validation: the Code Agent ran against `tejasvasingh2004/Code_man` with Groq up to
a local commit on an agent branch. Push and draft PR on github.com need a token with
**Contents** and **Pull requests** write permission.

## 4b. Bring your own key (Phase 1 of the orchestrator roadmap)

- **Provider keys per workspace** — Settings → Model providers, or `/v1/provider-keys`: add, check,
  remove. A key is verified with the provider before it is stored and shown afterwards only as its
  last four characters.
- **Envelope encryption** — a random data key per workspace, wrapped by a key-encryption key
  (AWS KMS, Google Cloud KMS or Vault Transit via `KEK_PROVIDER`, or derived from `SECRETS_KEY`); provider keys sealed with
  AES-256-GCM, bound to workspace, provider and id (`infra/migrations/0009_provider_keys.sql`,
  `packages/db/src/provider-keys.ts`).
- **Runs use the workspace's key** — the worker gives each run (and its conversation summary and
  Model Lab evaluations) a gateway view scoped to the workspace's keys; a tenant key has its own
  rate-limit scope, so one tenant's 429 never blocks another tenant or the platform pool. Model lists
  show whose key serves each model.
- **`PLATFORM_MODEL_KEYS=disabled`** — a public deployment serves models only with tenants' keys.
- **Revoked keys retire themselves** — a 401 from the provider on a workspace key during a run marks
  it invalid (audited); later runs stop using it.
- **Anthropic, OpenAI and Google providers** — Claude through the official Anthropic SDK
  (`packages/models/src/adapters/anthropic.ts`); OpenAI and Gemini through their OpenAI-compatible
  endpoints (`adapters/hosted.ts`). All three accept workspace keys and are listed in Settings →
  Model providers even when the server has no key of its own. Hosted open-weight models through
  Together AI, Fireworks AI and OpenRouter use the same OpenAI-compatible adapter with a profile per
  host (base URL, reasoning parameter, key check). Claude's thinking blocks are replayed
  unchanged inside a tool loop (opaque `providerState` on the assistant message) and never shown.
- **Dollar budgets** — a workspace sets daily and monthly spending limits and an alert threshold
  (Usage → Spending limits, `/v1/workspace/budget`); each workspace provider key can have a monthly
  budget (Settings → Model providers, `PATCH /v1/provider-keys/:id`). Runs are refused at admission
  once a workspace limit is reached, and workers check before every model call: a reached workspace
  limit stops the run with a clear message, a key over budget skips its provider (the run falls back
  to other models, never to the platform key). Crossing the alert threshold or a limit writes one
  audit event per period. Spend comes from recorded model-call costs (`infra/migrations/0010_budgets.sql`,
  `packages/bus/src/budgets.ts`).
- **Webhooks and async runs** — signed (Standard Webhooks) deliveries of `run.completed`,
  `run.failed`, `run.cancelled`, `run.approval_requested` and budget alerts to registered endpoints
  (Settings → Webhooks, `/v1/webhooks`) and to a run's own `webhookUrl`. A Postgres outbox delivered
  by every worker (`SKIP LOCKED`), retries for about two days, delivery log with resend, secret
  rotation with a 24-hour overlap, SSRF protection at save time and at connect time
  (`packages/bus/src/webhooks.ts`, `infra/migrations/0011_webhooks.sql`, [WEBHOOKS.md](WEBHOOKS.md)).
- **SDKs** — TypeScript (`packages/sdk`, `@neuroflow/sdk`, no dependencies, Node/Bun/Deno/browsers) and
  Python (`sdks/python`, `neuroflow`, standard library only): runs, resumable event streams, answer
  streaming, approvals, retries with `Retry-After`, automatic idempotency keys, typed errors and
  webhook verification. Tested against mocks and against the real API and worker.
- Phase 1 of the orchestrator roadmap is complete.

## 4c. Fast and cheap (Phase 2 of the orchestrator roadmap)

- **Gateway mode** — `/v1/chat/completions` with `neuroflow.gateway` streams one model call from
  the API process (no queue), with the same auth, quotas, budgets, workspace keys, retries and usage
  records (`apps/api/src/gateway-mode.ts`). **Gate passed:** overhead before the provider request
  p50 3 ms / p95 5–6 ms over 200 calls (target < 50 ms); time to first token 18 ms vs 127 ms on the
  queued path (mock model) — `apps/api/test/integration/gateway-mode.test.ts`.
- **Response cache** — opt-in exact-match cache per workspace, single-turn and tool-free only.
- **Cache-friendly prompts** — stable system core first, volatile tail after; Claude cache
  breakpoints; cached prompt tokens recorded (migration 0012), billed at cache-read prices and
  shown on the Usage page.
- **Parallel tool calls** — independent read-only calls of one model turn run concurrently.
- **Learned routing** — the router picks the cheapest model within 0.05 of the best measured
  quality per task class (14 days of evaluations, cost and latency), with a small exploration share.

## 4d. Self-healing (Phase 3 of the orchestrator roadmap)

- **Provider failover** — model families (GPT-OSS 120B on Groq, Together, Fireworks, OpenRouter …):
  the same model on another provider is tried before a different model.
- **Adaptive limits** — Gradient2-style concurrency limit per provider and process, driven by time
  to first token; providers' `x-ratelimit-*` headers hold an exhausted key until its reset.
- **Hedged first token** — opt-in: a late first token starts the next model in parallel; the first
  to answer wins.
- **Durable steps** — model calls are checkpointed (migration 0013); an interrupted run resumes on
  another worker from its last completed step with its original plan. **Gate passed:** worker
  killed mid-answer, the run resumes, completed model and tool calls are not repeated or billed
  twice — `apps/api/test/integration/durable-steps.test.ts`.
- **MicroVM sandbox** — `SANDBOX_RUNTIME=runsc` (gVisor) or `kata-fc` (Kata microVMs) for every agent
  command, failing closed when the runtime is missing; `INSTALL_GVISOR=1` in the VM setup script.
- Next (Phase 4 of the roadmap): MCP client and server, Chrome extension, GitHub App, Slack app,
  VS Code extension.

## 5. Scalability and reliability foundation

| Concern | Implementation | Where |
| --- | --- | --- |
| Provider rate limits shared by all workers | Atomic Lua token buckets on Redis time (tokens/requests per minute per key), key pools, provider `retry-after` honoured everywhere, `model.throttled` events | `packages/bus/src/rate-limit.ts`, `packages/models/src/gateway.ts` |
| Provider concurrency | Redis ZSET slot leases with expiry and heartbeat | `packages/bus/src/rate-limit.ts` |
| Provider failures | Circuit breaker per provider (closed → open → half-open, open period doubles after a failed trial), shown in Model Lab | `packages/models/src/circuit-breaker.ts` |
| Tenant limits | Plans free / pro / team / enterprise: per-route HTTP token buckets with `RateLimit` and `Retry-After` headers, admission caps, daily token quota (`quota_exceeded`) | `packages/contracts/src/plan-limits.ts`, `apps/api/src/rate-limit.ts`, `apps/api/src/plans.ts` |
| Job isolation | Separate queues: runs, workspace jobs, evaluations; priority = plan × 10 + source | `packages/bus/src/queue.ts` |
| Fairness | Per-tenant running-slot gate in the worker; excess jobs are delayed, not dropped | `apps/worker/src/workers.ts` |
| Usage | Daily token meter per workspace (UTC day), `GET /v1/workspace/usage` | `packages/bus/src/rate-limit.ts` |
| Health and alerts | `GET /status` (503 on no live worker, stuck queue, database/Redis down, no provider); worker heartbeats; `Uptime` workflow opens/closes an incident issue | `apps/api/src/routes/system.ts`, `packages/bus/src/heartbeat.ts`, `.github/workflows/uptime.yml` |
| Error tracking | Sentry envelope reporter (no SDK), redacted, de-duplicated, rate-capped; API 5xx and crashes, actionable worker failures | `packages/observability/src/errors.ts` |

The hosted deployment runs one API and one worker. API and workers are stateless (all shared state
is in Redis/PostgreSQL), and this is verified under load: the `infra/loadtest/` topology puts N API
replicas and M workers behind an nginx load balancer and drives them with k6.

| Same load: 100 reads/s + 10 runs/s for 60 s | 1 API + 1 worker | 2 APIs + 2 workers |
| --- | --- | --- |
| Runs admitted | 86 % (14 % refused by admission control) | 100 % |
| Admitted runs completed | 100 % | 100 % |
| Run end-to-end p50 / p95 | 20.5 s / 34.8 s | 2.6 s / 5.6 s |
| API read p95 | 16.6 ms | 10.7 ms |
| Load balancing | — | 50.1 % / 49.9 % |

Details and method: [`infra/loadtest/README.md`](../infra/loadtest/README.md). Multi-replica
start-up is safe: migrations take a PostgreSQL advisory lock.

## 6. Marketing site (`apps/site`)

- Separate static app, pre-rendered per route (`scripts/prerender.mjs`) and hydrated only when the
  HTML belongs to the current URL; changelog generated from Git history.
- Pages: Home, Download, Pricing (limits read from the same plan definitions the API enforces),
  Docs, Changelog, Login, 404.
- Design: icy blue glass (sky canvas, frosted panels with cyan edges, cobalt accents, navy text)
  with CSS 3D depth — floating glass panels, orbs, ribbons and terrazzo that react to the pointer
  and to scroll (`src/components/depth.tsx`). Sections: 3D hero, proof marquee, 3D "watch a run"
  demo, feature bento with live mini visuals, pinned scroll story with product screenshots, stats,
  interactive Cognitive Mode orb, steps, pricing, FAQ, CTA.
- Respects reduced motion; no WebGL dependency; pre-rendered HTML is complete without JavaScript.
- Placeholders by design: desktop downloads and paid prices say "Coming soon".

## 7. Deployment

| Part | Target | Config |
| --- | --- | --- |
| Marketing site | Vercel (static, clean URLs) | `apps/site/vercel.json` — set `VITE_APP_URL` to the web app URL |
| Web app | Vercel (static SPA with rewrites to `index.html`) | `apps/web/vercel.json` — set `VITE_API_URL` to the API URL |
| API | Railway (Nixpacks, Node 22, pnpm 9) | `nixpacks.toml` — starts `node apps/api/dist/main.js` |
| Worker | Separate process/service from the same build, on a VM with Docker | `infra/scripts/setup-worker-vm.sh` (one-command setup) |
| PostgreSQL, Redis | Managed services | `DATABASE_URL`, `REDIS_URL` |
| Self-host | Docker Compose (`infra`, `app`, `bci` profiles) and Dockerfiles in `infra/docker` | `docker-compose.yml` |

The sandbox needs a Docker daemon next to the worker. On hosts without Docker, code workspaces
open and the agent can read and edit, but test commands report the sandbox as unavailable.

## 8. How to run and verify

```bash
pnpm install
pnpm infra:up          # PostgreSQL :5433, Redis :6380
pnpm dev               # API :8080, worker, web :5173
pnpm --filter @neuroflow/site dev     # marketing site :5180
pnpm typecheck && pnpm lint && pnpm test
pnpm test:e2e          # Playwright (first run: playwright install chromium)
```

Admin CLI: `pnpm --filter @neuroflow/db cli set-plan --email <owner email> --plan team` (free, pro, team, enterprise).

## 9. History (milestones)

| Date | Milestone | Commits |
| --- | --- | --- |
| 2026-10 | Phase 1 runtime, gap audit, Phase 2 Code Agent and AI IDE, Model Lab | up to `af5972d` |
| 2026-10 | Hardening from the first real-repository run | `3c61332` |
| 2026-10-11 | Shared provider rate limits + circuit breaker; plans, quotas, admission; separate queues + fairness | `b05000d`, `32a4cb8`, `8596645`, `3f9a26a`, `248dc1a` |
| 2026-10-11 | CI pipeline | `4c409d1` |
| 2026-10-11 | Marketing site | `a27d1a7` |
| 2026-10-11 | Plan Review (backend, UI) | `0b97d5d`, `5eafabe` |
| 2026-10-11 | Workspace settings + task history API, Tasks and Settings pages | `fec466e`, `f4533f7` |
| 2026-10-11 | 3D landing page, then icy blue glass palette | `a032a81`, `2410e0c` |
| 2026-10-18 | Deployment configs (Vercel, Railway), runtime dependency fixes; `v2` merged into `master` | `4d133d4` … `dfad3fa` |
| 2026-10-22 | Usage page and usage history API; one-command worker VM setup script | `5470884`, `22ab5af` |
| 2026-10-22 | Load-balanced topology and k6 load test: 2 + 2 vs 1 + 1 | `f3bf172` |
| 2026-10-22 | Model identity in system instructions; error tracking; /status, worker heartbeats and uptime alerts | `03fff36`, `c652f57` |
| 2026-10-22 | Bring your own key: encrypted workspace provider keys, tenant-scoped gateway, Settings → Model providers | `654a5f2` |
| 2026-10-20 | Documentation brought up to date; open-source project structure (license, contributing, code of conduct, security policy, templates; docs moved to `docs/`) | — |

## 10. Open items

1. **Live push / PR on github.com** — grant the fine-grained token Contents and Pull requests write.
2. **Horizontal scale-out in production** — the load-balanced topology is built and load-tested
   (`infra/loadtest/`); the hosted deployment still runs one API and one worker.
3. **Workspace service and sandbox pool** — checkouts not tied to one host; isolated sandbox pool.
4. **Operations** — dashboards and metric alerts, frontend error reporting, backups, Redis HA,
   PgBouncer (`ROADMAP.md`). Error tracking and uptime alerts are in place.
5. **Product** — desktop app builds, payments, web search provider key, OIDC/SSO, pgvector memory.
   (Mid-run checkpoint/resume is done: durable steps, §4d.)
6. **Phase 2 non-goals stay out of scope** — VS Code parity, unrestricted shell, automatic
   deployment or merging, automatic training or fine-tuning on private code.
