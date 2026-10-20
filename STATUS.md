# NeuroFlow — Current State of the Repository

Living record of what is built, how it fits together, how it is verified and what is left.
Updated 2026-10-20 · branch `master` (includes the merged `v2` work).

Keep this file current: when a feature lands, add it here in the same commit. Requirements live in
`prd.md`; detailed checklists in `progress.md`; design rationale in `docs/decisions.md`; open
infrastructure work in `TODO.md`.

---

## 1. At a glance

| | |
| --- | --- |
| Product | AI workspace (Product Phase 1) + AI Code Agent / AI IDE (Product Phase 2) on **one** runtime |
| Stack | React 19 · Vite 7 · Tailwind 4 · TanStack Query · Zustand · Monaco — Node 22 · Fastify 5 · Zod 4 · BullMQ — PostgreSQL · Redis · Docker · OpenTelemetry |
| Models | Groq (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3-32b`, …) and local Qwen through Ollama, all behind the Model Gateway |
| Apps | `apps/api` (Fastify), `apps/worker` (BullMQ), `apps/web` (product UI), `apps/site` (marketing site) |
| Packages | `contracts`, `orchestrator`, `models`, `tools`, `memory`, `cognitive`, `code`, `bus`, `db`, `observability` |
| API | 105 routes, including `POST /v1/chat/completions` (OpenAI-compatible) |
| Database | 7 migrations (`infra/migrations/0001` … `0007`) |
| Tests | ~220 unit tests across 13 packages, 45 integration tests (real Postgres, Redis, BullMQ, Git, Docker), 15 Playwright E2E flows |
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
- **Workspace Settings** (`/code/:id/settings`) — approval mode, default model, Plan Review default,
  project command overrides, sandbox image, instructions editor, archive. Stored in
  `code_workspaces.settings` (migration 0007).

Real-repository validation: the Code Agent ran against `tejasvasingh2004/Code_man` with Groq up to
a local commit on an agent branch. Push and draft PR on github.com need a token with
**Contents** and **Pull requests** write permission.

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

Today the system runs as one API process and one worker process per environment. API and workers
are stateless (all shared state is in Redis/PostgreSQL), so adding replicas behind a load balancer
needs no code change; see `TODO.md` for the infrastructure steps.

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
| Worker | Separate process/service from the same build | `node apps/worker/dist/main.js` |
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

## 10. Open items

1. **Live push / PR on github.com** — grant the fine-grained token Contents and Pull requests write.
2. **Horizontal scale-out** — 2+ API replicas and workers behind a load balancer, SSE-friendly
   timeouts, load test (`TODO.md` §1).
3. **Workspace service and sandbox pool** — checkouts not tied to one host; isolated sandbox pool.
4. **Operations** — dashboards and alerts, error tracking, backups, Redis HA, PgBouncer
   (`TODO.md`).
5. **Product** — desktop app builds, payments, web search provider key, OIDC/SSO, pgvector memory,
   mid-run checkpoint/resume.
6. **Phase 2 non-goals stay out of scope** — VS Code parity, unrestricted shell, automatic
   deployment or merging, automatic training or fine-tuning on private code.
