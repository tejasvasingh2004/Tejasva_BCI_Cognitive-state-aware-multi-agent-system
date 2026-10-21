# Load test: horizontal scaling

Runs the same load against different topologies — N API replicas and M workers behind an nginx
load balancer — and compares throughput, latency and back-pressure.

```text
k6 (8 tenants on the enterprise plan)
  │  reads: GET /v1/models, /v1/workspace/usage        (API tier only)
  │  runs:  POST /v1/runs, then poll until finished     (API → queue → worker → model → DB)
  ▼
nginx load balancer (least_conn, SSE-friendly, logs the replica that served each request)
  ▼
API × N ──► Redis: queues, rate limits, events ──► worker × M (concurrency 4 each)
  │                                                    │
  └────────────── PostgreSQL ◄─────────────────────────┴──► mock model provider (~1 s per call)
```

The model provider is a mock OpenAI-compatible server on the host
(`packages/models/src/testing/serve.ts`), so no provider tokens are spent and model latency is
constant. PostgreSQL and Redis run in an isolated Compose project with throw-away volumes and
credentials generated per run.

## Run it

```bash
infra/loadtest/run.sh                                   # 1x1 and 2x2, 100 reads/s + 5 runs/s, 60 s
RUN_RATE=10 infra/loadtest/run.sh                       # heavier run load
TOPOLOGIES="1x1 2x2 3x3" DURATION=90s infra/loadtest/run.sh
```

Requirements: Docker with Compose v2.24+, Node 22, `pnpm install`. Results are written to
`infra/loadtest/results/<topology>.json` and `<topology>-balance.txt` (requests per API replica).

## Results (2026-10-22)

One Windows laptop running everything (Docker Desktop), worker concurrency 4, mock model calls of
about 1 s. Offered load: **100 reads/s + 10 runs/s for 60 s** across 8 tenants.

| | 1 API + 1 worker | 2 APIs + 2 workers |
| --- | --- | --- |
| Runs sent by k6 | 487 | 590 |
| Runs admitted | 420 (86 %) — **67 refused** by admission control | **590 (100 %)** |
| Admitted runs completed | 420 / 420 | 590 / 590 |
| Run end-to-end p50 | 20.5 s | **2.6 s** |
| Run end-to-end p95 | 34.8 s | **5.6 s** |
| Read p50 / p95 / p99 | 5.2 / 16.6 / 32.2 ms | 4.8 / 10.7 / 19.9 ms |
| Read error rate | 0 % | 0 % |
| Requests per API replica | 23,148 | 5,089 / 5,072 (50.1 % / 49.9 %) |

What it shows:

- **Horizontal scaling works without code changes.** API replicas are stateless and workers share
  the queues, so doubling both roughly doubled run throughput, removed queueing (p50 20.5 s →
  2.6 s, about 8× faster) and admitted every run.
- **Back-pressure instead of collapse.** Past capacity, admission control refused 14 % of runs
  with 429/503 rather than letting the queue grow without bound; nothing admitted was lost.
- **The load balancer spreads load evenly** (50.1 % / 49.9 %), and API read latency stays in
  milliseconds in both topologies — the API tier is not the bottleneck; workers are.
- In the 1×1 run the API also served 2.3× more requests in total, because clients poll slow runs
  for longer.

Caveat: "runs sent" differ because k6 could not start every scheduled iteration on the same
laptop (113 dropped in 1×1, 11 in 2×2) — a limit of the load generator, not a server error. On
separate machines both topologies would receive the full 600.

At 5 runs/s (below single-worker capacity) the same comparison gave run p50 2.6 s vs 1.0 s and
p95 3.6 s vs 1.1 s, with every run admitted and completed in both topologies.
