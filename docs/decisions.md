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
