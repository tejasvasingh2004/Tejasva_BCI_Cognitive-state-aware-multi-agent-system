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
