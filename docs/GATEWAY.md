# Gateway mode, caching and latency controls

NeuroFlow has two ways to serve a request:

- **Orchestrator mode** (default): a run, with routing, agents, tools, memory, evaluation and live
  events, executed by a worker.
- **Gateway mode**: a single model call streamed straight from the API process: no queue, no agents
  or server tools. Same authentication, rate limits, quotas, dollar budgets, workspace keys,
  retries, fallbacks and usage records. Use it when you want an LLM gateway with NeuroFlow's
  reliability and accounting, and the lowest latency.

## Gateway mode

Any OpenAI client works against `POST /v1/chat/completions`; add `neuroflow.gateway` (or the header
`x-neuroflow-mode: gateway`):

```bash
curl https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $NEUROFLOW_API_KEY" -H "Content-Type: application/json" \
  -d '{
        "model": "groq/openai/gpt-oss-120b",
        "stream": true,
        "messages": [{ "role": "user", "content": "Summarise this paragraph: ..." }],
        "neuroflow": { "gateway": true }
      }'
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://api.example.com/v1", api_key=NEUROFLOW_API_KEY)
client.chat.completions.create(model="anthropic/claude-haiku-5-5", messages=[...],
                               extra_body={"neuroflow": {"gateway": True}})
```

`model` is a `<provider>/<model>` id from `GET /v1/models`, or `neuroflow-auto` for the workspace's
default. Client-defined `tools` are passed through and returned as `tool_calls`.

Responses carry `x-neuroflow-mode: gateway` and `server-timing: overhead;dur=<ms>` (time from the
request's arrival to the provider request); JSON responses also include
`neuroflow: { mode, overhead_ms, ttft_ms, cost_usd }`. Each call is recorded afterwards as a
completed run, so it appears in usage, budgets and history.

Measured on the integration stack with a mock model: overhead p50 3 ms, p95 5–6 ms over 200 calls;
time to first token p50 18 ms in gateway mode vs 127 ms through the queued run path.

## Response cache

Opt in per request with `neuroflow.cache_ttl_seconds` (up to 86 400):

```json
{ "model": "groq/openai/gpt-oss-20b", "messages": [{ "role": "user", "content": "Define idempotency." }],
  "neuroflow": { "gateway": true, "cache_ttl_seconds": 3600 } }
```

An identical request (same model, messages and parameters) within the TTL is answered from the
cache: `x-neuroflow-cache: hit`, no provider call, no cost. Exact match only, scoped to the
workspace (one tenant never sees another's answers), and only for single-turn requests without
tools, so an answer cannot leak across conversations or depend on tool results.

## Provider prompt caching

NeuroFlow lays prompts out so providers can reuse them: stable instructions first, volatile parts
(date, summary, editor context) after. OpenAI-compatible providers cache the common prefix
automatically; Claude gets explicit cache breakpoints. Cached input tokens are reported in
`usage.prompt_tokens_details.cached_tokens` (and on the Usage page) and billed at the cache-read
price where it is known.

## Hedged first token

If a call has produced no output after N ms, the same call also goes to the next model in the
chain (usually the same model on another provider); the first to answer wins and the other is
cancelled. It cuts tail latency but the cancelled request may still cost prompt tokens, so it is
opt-in:

- per gateway call: `neuroflow.hedge_after_ms`;
- per run: `hedgeAfterMs` in the run request;
- for a whole deployment: `MODEL_HEDGE_AFTER_MS`.

## Reliability the gateway applies to every call

| Mechanism | What it does | Setting |
| --- | --- | --- |
| Provider failover | The same model (e.g. GPT-OSS 120B on Groq, Together, Fireworks, OpenRouter) on another provider is tried before a different model | `MODEL_EQUIVALENT_FAILOVER` |
| Adaptive concurrency | A per-provider limit that grows while time to first token is flat, shrinks when it climbs, backs off on 429/5xx/timeouts | `MODEL_ADAPTIVE_CONCURRENCY`, `MODEL_ADAPTIVE_INITIAL`, `MODEL_ADAPTIVE_MAX` |
| Provider rate-limit headers | A key the provider reports as nearly exhausted (OpenAI-style `x-ratelimit-*` or Anthropic `anthropic-ratelimit-*` headers) is held until the provider's reset, across all workers | always on |
| Learned routing | Without an explicit model, the router picks the cheapest model whose measured quality for the task class is within 0.05 of the best | `ROUTER_LEARNING`, `ROUTER_EXPLORATION`, `ROUTER_MIN_SAMPLES` |
| Durable steps | A run interrupted by a worker crash resumes from its last completed model call on another worker | always on |
