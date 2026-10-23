# Implementation decisions

Decisions taken while implementing NeuroFlow v4, including contradictions between the planning
documents and how they were resolved (per PRD §1: conflicts are called out, not silently chosen).

## Resolved contradictions

| Topic | Documents | Resolution |
| --- | --- | --- |
| Strategy names | `system-design.md` uses `"single"`; prompt uses `SINGLE_AGENT` | Contracts use lowercase snake_case: `direct`, `single_agent`, `sequential`, `parallel`, `supervisor`, `evaluator_optimizer`; requests may also send `auto`. |
| Reasoning field | `reasoning_budget` (architecture) vs `reasoningBudget` (system design) and `OFF/LOW…` vs `off/low…` | `reasoningBudget: 'off' \| 'low' \| 'medium' \| 'high'` in contracts; the OpenAI boundary maps `reasoning_effort`. |
| Event names | `execution.started` (architecture) vs `run.started` (PRD); `model.delta` vs `response.delta` | PRD superset: `run.started`, `response.delta` (user-visible text only). Added `context.built`, `cognitive.applied`, `model.retry`, `model.fallback`, `approval.requested/resolved`, `response.reset`. |
| Run lifecycle | PRD lists `CREATED` before `QUEUED`; the prompt's Run type starts at `queued` | Runs are persisted directly as `queued` (creation and queueing are one transaction); `run.created` and `run.queued` are both emitted as events. |
| Package list | Prompt lists `agents`, `context`, `evaluation`, `ui` packages | Implemented as modules (`orchestrator/src/{agents,context,evaluation}`, `web/src/components/ui`) to avoid packages created only for appearance; split when a second consumer exists. |
| WebSocket vs SSE | Docs prefer WebSocket for cancel/approval | Both exist: SSE for events and a WebSocket control stream. The web app uses SSE + REST commands (simpler, proxy-friendly); cancellation/approvals behave identically either way. |

## Notable choices

- **Qwen provider**: the Qwen adapter targets any OpenAI-compatible Qwen endpoint — local Ollama
  (default, `reasoning_effort` controls thinking) or DashScope (`enable_thinking` /
  `thinking_budget`). Groq uses `reasoning_format: hidden` / `include_reasoning: false`. Provider
  reasoning fields are discarded and `<think>` blocks stripped (defence in depth).
- **Retry semantics**: the gateway retries/fails over only before any output was streamed;
  after that a failure is `interrupted` (never duplicated text). Side-effecting tools are never
  retried and completed side-effecting tool calls are not re-run on recovery.
- **Event ordering**: events are persisted before they are published; subscribers replay from
  Postgres then follow Redis without gaps. Token deltas are coalesced (~60 ms) to bound writes.
- **Recovery**: a worker shutdown/crash releases the job for retry; the next attempt emits
  `response.reset` and re-executes. A reconciler repairs runs whose job disappeared.
- **Routing**: deterministic heuristics (no extra model call). Questions default to a single agent
  with tools available so the *model* decides whether to use memory/tools; conversational turns go
  direct; multi-agent strategies need clear complexity signals.
- **Evaluation**: heuristic by default; model evaluation when cognitive policy asks for it, when
  the user asks for verification, or in `evaluator_optimizer`.
- **OpenAI clients** get append-only streams (no `response.reset`); client-side tool definitions
  are not executed by NeuroFlow.
- **Cognitive Mode**: stored manual self-report wins, otherwise a recent BCI sample, otherwise a
  live BCI call; unavailability never blocks execution. The original LOW/MEDIUM/HIGH policy table
  was ported as bounded preferences (density, chunking, strategy cap, evaluation).
- **Authentication**: API keys (sha256-hashed, scoped) and signed session cookies; `AUTH_MODE=dev`
  adds passwordless dev login. Production identity-provider integration is a follow-up.
- **Legacy code**: the Next.js dashboard was removed (in git history). The Python LangGraph
  runtime in `backend/app/main.py` is superseded; `backend/app/bci_service.py` exposes only the
  EEG classifier for Cognitive Mode.

## Second pass (gap audit against PRD / architecture / system design)

An audit of every testable requirement in the planning documents found the gaps below; all
MVP items were implemented. Further contradictions found and how they were resolved:

| Topic | Documents | Resolution |
| --- | --- | --- |
| Routing library | architecture §2 lists React Router | A ~25-line path router (`/`, `/c/:id`) covers the two routes; React Router can be adopted when more routes appear. |
| `RunRequest.stream`, `tools: ToolReference[]` | system-design §2 | Every run streams through events, so `stream` only exists at the OpenAI boundary. `tools` is a list of tool names (server tools); client-defined tools use `clientTools`. |
| Event payloads | system-design §13 (`tool.completed.result`, `run.failed.error: string`) | `tool.completed` carries status/summary/error code only (results are bounded and stay server side); `run.failed.error` is a structured `RunError`. |
| `CREATED` run status | PRD §9.1 | Not persisted as a status: creation and queueing happen in one transaction; `run.created` and `run.queued` are both emitted. |
| `model.delta` vs `response.delta` | PRD §25 | Only `response.delta` (user-visible text) is exposed; intermediate agent output is never streamed, which also avoids leaking internal drafts. |
| `CognitiveStateProvider.getState(sessionId)` | system-design | `getState({ workspaceId, userId }, signal)`: state is per user per workspace; there is no separate cognitive session object. |
| `AgentDefinition.modelPolicy` | system-design §9 | Agents declare a `modelRole`; the router assigns models to roles per run (keeps agent/model independence). `capabilities` and an `outputContract` were added. |
| Package layout | CLAUDE.md (separate agents/context/evaluation/ui packages) | Kept as modules of `orchestrator` / `web` (see above); `bus` and `db` were added as real boundaries. |
| Non-streaming OpenAI requests | PRD §2.2/§43 vs §12 | The HTTP request waits (bounded by `RUN_WAIT_TIMEOUT_MS`) but the work runs in a worker like every run; streaming is recommended for long tasks. |
| WebSocket for control | PRD §26 | Both exist; the web app uses SSE + REST commands, API clients may use `/v1/runs/:id/stream`. |
| Production authentication | PRD §37 does not choose a mechanism | Email + password accounts (scrypt) provisioned by an operator with `pnpm user:create`, signed session cookies, API keys for programs. OIDC/SSO can be added as another way to establish the same session. |
| Audit events | Required by CLAUDE.md, absent from PRD §40 | Implemented as an append-only `audit_events` table (never secrets or message content). |

### Choices made in this pass

- **Budgets**: per-run tool-call budget across all agents (plus per-agent limits), a wall-clock
  budget that aborts in-flight model/tool calls, and an optional cost budget. Callers may only
  tighten limits (`budget.maxDurationMs`, `budget.maxCostUsd`).
- **Cost**: Groq list prices are built in, local Ollama is free, anything else via `MODEL_PRICING`.
  Cost is an estimate from reported token usage.
- **Router**: latency budget < 60 s caps automatic strategies at a single agent and prefers the
  fastest model; a cost budget restricts to priced models; the cognitive policy contributes a
  model preference (overloaded → fastest, spare attention → strongest).
- **Evaluation** additionally checks structured output (JSON / JSON Schema via ajv), the
  trajectory (repeated identical tool calls, hit limits, exhausted budgets) and policy compliance
  (tools outside the allowed set, declined approvals, invalid arguments).
- **Supervisor** reviews specialist results and may run one follow-up round (max two rounds, only
  when the remaining model-call budget allows).
- **Context**: workspace instructions and a rolling conversation summary (fast model, after 24
  unsummarised messages, keeping the latest 12 verbatim) are bounded context sources.
- **Memory retention**: optional per-memory TTL plus a workspace retention policy evaluated at
  query time (changes apply retroactively); expired memories are purged by the worker and audited.
- **Client tools** (OpenAI `tools`): offered to the model in a direct call; calls are returned to
  the client and never executed by NeuroFlow.
- **Notifications**: Standard Mode = toast + desktop notification when the tab is hidden; in
  Cognitive Mode the policy's notification intensity reduces this (overloaded → title badge only).
- **Web search**: provider-neutral `web_search` tool (Tavily, Brave, self-hosted SearXNG), only
  registered when configured.

### Deliberately deferred (documented as future in the PRD/architecture)

- Semantic (pgvector) memory retrieval — full-text search behind the same `MemoryService`.
- Interaction-derived cognitive state provider.
- Mid-graph checkpoint resume — recovered runs restart (completed side-effecting tool calls are
  not repeated).
- OIDC / SSO identity providers.

## Product Phase 2 (AI Code Agent / AI IDE workspace)

Phase 2 reuses the Phase 1 runtime end to end. There is no separate code-agent backend, model
service, tool runtime or queue.

### Contradictions and ambiguities resolved

| Topic | Documents | Resolution |
| --- | --- | --- |
| "Workspace" | Phase 1 workspace = tenant; Phase 2 workspace = repository checkout | Two names: *workspace* (tenant, isolation unit) and *code workspace* (a checkout of one repository branch owned by a tenant workspace). |
| Code run API | PRD lists `/v1/code/runs`; the runtime has `/v1/runs` | `/v1/code/runs` is a structured front door that builds a normal `RunRequest` with `workspaceContext`; events, cancellation and approvals reuse the run endpoints. |
| Approval of patches | "Show diff → approval" vs the generic tool approval flow | Editing tools are two-phase (`prepare` → approval with a diff preview → `execute`). A patch review *is* a Tool Runtime approval, so every policy, timeout and audit path is shared. |
| Push / PR authority | PRD allows the agent to push and open PRs | The agent may call `push` / `create_pull_request` only with explicit per-call approval in every mode. Users can also commit/push/PR from the Git panel. Pushes are limited to `neuroflow/agent/*` branches; commits on the base branch are moved to a new agent branch. Nothing is ever merged. |
| Sandbox location | "Agent worker → sandbox" | Sandbox containers are started by the worker through the Docker daemon; the API never executes repository commands. In docker compose the worker gets the Docker socket and the checkouts live at an identical host/container path so bind mounts resolve. |
| Fine-tuning | PRD Model Lab includes fine-tuning | Provider-dependent. Ollama and Groq do not offer fine-tuning through NeuroFlow; DashScope is "not yet supported". The UI and API say so, and job creation is refused with the reason. Datasets can be exported (reviewed examples only) for use elsewhere. |
| Training data | "Learn from agent interactions" vs "never train on private repositories" | Examples are created only by explicit user action (manual, import, or "Save to dataset" from a run replay) and are exported only after a human marks them reviewed. |

### Notable choices

- **Git via the CLI** (not a JS reimplementation). Credentials are passed per command through
  `GIT_CONFIG_*` environment headers, prompts are disabled, and an empty global config is used.
  The token never touches the remote URL, the checkout's config or the model.
- **Diff of untracked files** uses a temporary index copy, so the real index is never modified.
- **Path policy**: every repository path is normalized and confined to the checkout (no `..`,
  absolute paths, drive letters, `.git`, or symlink escapes).
- **Command policy**: a deny list (privilege escalation, destructive filesystem operations, Docker,
  remote shells, `curl | sh`, Git remote/config/push, environment dumps) applies to agent and user
  commands alike; network access is granted only to dependency installs.
- **Monaco is bundled locally** with Vite workers (no CDN), loaded only when a code workspace opens.
  IntelliSense and diagnostics come from Monaco's language services for TS/JS/JSON/CSS/HTML; other
  languages get syntax highlighting (full IDE language support is a non-goal).
- **Live workspace events** (sync status, user terminal output, user Git operations) use a Redis
  pub/sub channel per code workspace and SSE. They are transient. Agent activity is on the
  persisted run event stream, which is what Replay reads.
- **Replay** reads `run_events` plus the stored patches, executions, approvals and Git operations;
  it never calls a model, a tool or Git.

### Verification status

The completion-gate flow (GitHub → repository → Code Agent → plan → edit → diff → approval → test →
fix → commit → push → PR) is verified by integration and Playwright tests, using a real Git remote,
real Docker sandbox and a mock GitHub REST API. The same flow against github.com needs a GitHub
token and a test repository.

## Scalability and reliability foundation (rate limiting, circuit breaking, plans, queues)

### Model provider budgets (shared token buckets)
- **Problem:** provider concurrency was an in-process semaphore, so N workers allowed N× the
  limit, and per-minute token quotas (e.g. Groq on_demand: 8 000 tokens/minute) were only
  discovered through 429 responses.
- **Design:** a `RateLimiter` interface in `@neuroflow/models` with a Redis implementation in
  `@neuroflow/bus`. Each provider API key has a token bucket and a request bucket that refill
  continuously (capacity = per-minute limit), checked and updated in one Lua script on the Redis
  clock (atomic, no clock skew between machines). Concurrency uses sorted-set leases with expiry,
  so a crashed holder cannot keep a slot.
- **Flow per attempt:** estimate tokens → reserve on the first key of the pool with capacity
  (round-robin) → wait (emits `model.throttled`) or, beyond `MODEL_MAX_RATE_LIMIT_WAIT_MS`, fall
  back to the next model → send → correct the bucket with real usage (refund on failure). A
  provider "retry after" blocks that key for every worker.

### Circuit breaker
- Per provider, per process: closed → open after `MODEL_CIRCUIT_FAILURES` consecutive health
  failures (unavailable, timeout, provider error, interrupted) → half-open after the open period
  (one trial request) → closed on success, or open again for twice as long.
- Rate limits, bad requests, auth errors and cancellations do not count: they are not health
  signals. An open provider is reported unavailable, so routing and fallbacks avoid it.
- Per-process state is deliberate: each worker learns within a few requests, and no shared
  dependency is added to the hot path.

### Plans, HTTP rate limits and admission control
- `workspaces.plan` (free / pro / team / enterprise) is the single source of limits
  (`packages/contracts/src/plans.ts`); environment values are optional overrides for operators
  and tests. Plans are cached 30 s per API process.
- HTTP: token buckets per tenant and route class (general requests, run creation, sandbox
  commands) through the same Redis limiter, plus per-IP limits before authentication. Responses
  carry `RateLimit-Limit`/`RateLimit-Remaining`; rejections are 429 with `Retry-After`.
- Admission (back-pressure) at run creation: active runs per workspace and per user, daily model
  tokens (`quota_exceeded`, resets at UTC midnight), global backlog (503). Token usage is metered
  by the worker per workspace per UTC day in Redis, which is also the input for billing.
- This replaces `@fastify/rate-limit`'s flat per-minute counter.

### Separate queues and fair scheduling
- Bulkheads: `neuroflow-runs`, `neuroflow-workspace` (repo sync, terminal commands) and
  `neuroflow-evals` (Model Lab), each with its own worker and concurrency; `WORKER_QUEUES` lets a
  process serve a subset, so tiers scale independently.
- Priority = plan priority × 10 + source offset (interactive workspace before API traffic).
- Fairness: BullMQ OSS has no per-group concurrency, so the worker takes a Redis slot
  `running:<workspace>` (heartbeat-renewed lease, plan `runningPerWorkspace`) before executing a
  run; without a slot the job is delayed 1–2 s (`DelayedError`, no attempt used) and other
  tenants' jobs proceed. Admission caps bound how many jobs a tenant can queue in the first place.
- Jobs left on the old single queue are still processed by the runs worker.

## Plan Review, Tasks and Workspace Settings

### Plan Review
- **Opt-in, not default.** Most tasks are small; a mandatory review step would slow them down.
  It is enabled per task ("Plan first" in the composer) or per workspace (Workspace Settings →
  "Review plans first"); an explicit value in the request wins over the workspace default.
- **Same approval channel as patches.** The orchestrator waits on the existing approval gate
  (`control.waitForApproval`), whose messages now carry a `data` payload (edited steps, feedback).
  No new transport, and the wait survives across API processes because it goes through Redis.
- **Decisions:** approve (optionally with edited steps or summary), revise (feedback, at most
  `MAX_PLAN_REVISIONS = 3` new plans) or reject (the run ends without touching the repository).
  `PlanDecisionBody` is a discriminated union so each decision is validated on its own shape.
- **Timeout:** at least 15 minutes (`max(approvalTimeoutMs, 15 min)`), longer than a patch review,
  because reading a plan takes more time than reading a one-line diff.
- The approved plan is given to the agent as an explicit instruction ("Plan approved by the user —
  follow it"); events `plan.review_required`, `plan.approved`, `plan.rejected` make the decision
  visible in Activity and Replay. Migration 0006 adds `plan` as an approval subject.

### Workspace Settings
- Stored as `code_workspaces.settings` jsonb (migration 0007) rather than new columns: the set of
  defaults (default model, Plan Review default, sandbox image) is expected to grow, and every
  field is optional with a code-side default.
- Validated at the API: the default model must exist in the Model Lab catalogue (or be an active
  `deployment/<name>`), and the sandbox image must come from a curated list
  (`SANDBOX_IMAGE_CHOICES`), so a workspace setting can never point the sandbox at an arbitrary
  image.
- Command overrides are a partial map; an empty value removes the override and falls back to the
  detected command. Settings are stripped from the public workspace payload and returned by the
  workspace detail endpoint only.

### Tasks
- The task list is a query over existing run records (status, timing, cost, tokens, diff stats,
  tests, agent branch, PR reference, whether the plan was reviewed) — no new table. Replay stays
  read-only.

## Marketing site

- **Separate app** (`apps/site`), not routes inside `apps/web`: it deploys and caches
  independently, never ships the product bundle, and can be hosted on a static CDN.
- **Pre-rendered** per route with the SSR bundle; the client hydrates only when the HTML belongs to
  the current URL (`data-route`), because some hosts serve the home page for unknown paths.
- **Animation without hiding content:** reveal effects start visible in the HTML and only animate
  elements that are below the fold when the page loads, so crawlers and no-JS visitors see
  everything. Framer Motion's initial `opacity: 0` in SSR output was replaced by CSS animations.
- **3D with CSS, not WebGL:** perspective transforms driven by CSS variables (`--px`/`--py` for the
  pointer, `--sy`/`--p` for scroll) written by a small `Stage` component in `requestAnimationFrame`.
  No React re-render per frame, no large 3D library, text stays crisp, and the pre-rendered page is
  complete. Orbit labels use `offset-path` instead of nested 3D transforms, which flattened.
- **Palette:** icy blue glass (sky canvas, frosted panels with cyan edges, cobalt accent, navy
  text) chosen to match a reference image; the earlier warm porcelain palette was replaced.
- Plan limits on the pricing page are imported from the same definitions the API enforces, through
  a zod-free entry point (`@neuroflow/contracts/plans`) so the site bundle stays small.

## Deployment

- Static frontends on Vercel (`apps/site`, `apps/web`), each with its own `vercel.json`; the web app
  rewrites every non-asset path to `index.html` for client-side routing.
- The API builds with Nixpacks on Railway (Node 22, pnpm 9 via corepack). `.npmrc` hoists
  dependencies (`shamefully-hoist`) because the bundled API resolves some runtime packages from the
  root at start-up; runtime dependencies (e.g. `pino`) are declared explicitly in `apps/api` and
  `apps/worker`.
- The worker is a separate process from the same build and needs a Docker daemon for the sandbox;
  hosts without Docker can still serve the API and the web app.

## Bring your own key (BYOK)

- **Envelope encryption, KMS-ready.** Each workspace gets a random 256-bit data key, stored only
  wrapped by a key-encryption key; provider keys are sealed with AES-256-GCM under the data key. The
  authenticated data binds each ciphertext to workspace, provider and key id, so a ciphertext copied
  to another row will not open. The KEK sits behind `KeyEncryptionKey`: `SECRETS_KEY` derives it
  today (with a distinct derivation from the key that seals GitHub tokens); a KMS implementation
  replaces it without touching stored provider keys, which only need their data keys re-wrapped.
- **Write-only keys.** A key is verified with the provider (`GET /models` with the key) before it is
  stored. Afterwards the API returns only its last four characters; a keyed hash (HMAC with the
  workspace's data key) detects duplicates without storing anything reversible. Only workers decrypt,
  per run, and the result is never logged, persisted or sent to a model.
- **The gateway does not know about tenants.** A request carries optional credentials; the worker
  builds a per-run view with `gateway.scoped(credentials, { platformKeys })` and hands it to the
  orchestrator for the whole run (routing, defaults, every model call). The orchestrator, router and
  strategies are unchanged.
- **Isolated budgets.** A tenant key gets its own rate-limit scope (`<provider>:tenant:<keyId>`):
  a provider `retry-after` on one tenant's key blocks only that key. Platform token buckets and
  concurrency slots protect the platform's keys and do not apply to tenant keys.
- **Platform keys are a deployment choice.** `PLATFORM_MODEL_KEYS=enabled` (default) lets platform
  keys serve workspaces without their own; `disabled` makes a deployment BYOK-only. A workspace key
  always wins for its provider. An invalid key is skipped until it verifies again.
- **KMS.** `KEK_PROVIDER=aws-kms` wraps data keys with AWS KMS `Encrypt`, binding each to its
  workspace with the KMS encryption context (enforced by `Decrypt`, visible in CloudTrail); the SDK
  is loaded only when configured. `KEK_PROVIDER=vault` uses HashiCorp Vault or OpenBao Transit,
  free and self-hostable; the workspace context is sealed with the data key and checked on unwrap,
  so it works with any Transit key. A key ring holds the primary KEK plus the local one: data keys
  wrapped before a migration still open and are re-wrapped with the primary on first use, or all
  at once with `pnpm keys:rewrap`. Provider keys themselves are never re-encrypted. Google Cloud KMS
  fits the same `KeyEncryptionKey` interface (not implemented).
- **Not yet:** marking a key invalid automatically when a run gets an authentication error.

## Dollar budgets

- **Spend is the recorded cost of model calls.** Each `model_calls` row already carries its estimated
  cost (catalogue list prices or `MODEL_PRICING`); it now also records the workspace and the provider
  key that served it. Limits are UTC days and UTC calendar months. Calls to models without a known
  price do not count and are reported as unpriced; self-hosted models cost 0.
- **Postgres is the truth, Redis is the counter.** Checks happen before every model call, so they
  read a Redis counter (micro-dollars, `INCRBY`) instead of summing rows. A missing counter (new
  period, Redis restart, eviction) is seeded from Postgres on read; workers add a call's cost only to
  counters that exist (a Lua `EXISTS`/`INCRBY`), after the row is stored, so a seed never counts a
  call twice. A call recorded while its counter is being seeded can be missed until the counter
  expires: limits are soft by about one call.
- **Three enforcement points.** The API refuses new runs when a workspace limit is reached (429
  `quota_exceeded` with the limit, spend and reset time). Workers pass a guard to the run's gateway
  view that is checked before every model of the fallback chain: a reached workspace limit stops the
  run (`spend_limit`); a key over its budget skips that provider, so the chain falls back to other
  models. It never falls back to a platform key, which would move the tenant's spending onto the
  platform without anyone deciding to. A single call can overshoot a limit; the next one is refused.
- **Fresh on refusal.** Budgets are cached for 15 s per process; a refusal is confirmed against
  freshly read budgets, so a raised limit applies at once on every server.
- **Alerts are audit events now, webhooks next.** The first time per period that spend crosses the
  alert threshold or the limit, the worker writes `budget.threshold_reached` or `budget.exceeded`
  (de-duplicated with a Redis `SET NX` per limit and period). Webhooks will deliver the same events.

## Anthropic, OpenAI and Google providers

- **Claude uses the official SDK, not an OpenAI-compatible shim.** The Messages API differs in ways
  that matter: system text is a top-level field, tool results are blocks in a user turn, and an
  assistant turn's thinking blocks must be sent back unchanged while a tool loop continues (their
  signatures are bound to the model and the conversation). The adapter maps all of this; nothing
  outside `packages/models` sees the Anthropic format.
- **Opaque provider state.** The gateway returns an assistant turn's provider-native content as
  `providerState` ({ provider, model, content }). The orchestrator keeps it on the tool-loop scratch
  message and passes it back; adapters use it only when provider and model match. It is never shown,
  logged or persisted, and the public `ChatMessage` contract is unchanged (`ModelMessage` extends it
  inside the models package).
- **Stale thinking recovers once.** If the API reports that a replayed thinking block belongs to a
  different conversation (for example after the context engine compacted an old tool result), the
  adapter strips thinking blocks and retries once, before any output. Context compaction stays
  allowed; it costs that turn's earlier reasoning, not the run.
- **Parameters follow each provider's current models.** Claude: adaptive thinking with its text
  omitted, `reasoningBudget` → `output_config.effort` (off → low), no sampling parameters, and
  `required` tool choice sent as `auto` (forced tool choice is rejected). OpenAI reasoning models:
  `max_completion_tokens`, `reasoning_effort`, no temperature. Gemini: `reasoning_effort`, with
  `minimal` for off (current Gemini models always think).
- **Registered for BYOK without platform keys.** The three providers are always registered with a
  default catalog, so any workspace can add a key; without a server key their models are unavailable
  in the platform view and never chosen for workspaces that lack a key.
- **Fine-tuning is stated honestly.** No fine-tuning jobs are started for these providers; OpenAI's
  own dashboard is named as the place where its fine-tuning lives.
