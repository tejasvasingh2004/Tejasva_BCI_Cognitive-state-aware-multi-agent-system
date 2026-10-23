# NeuroFlow — System Design TODO

> Generated from the System Design Audit — every item links to the gap it closes.  
> **Scorecard**: 64 ✅ Exists · 3 ⚠️ Partial · 16 ❌ Missing  
> Updated 2026-10-24 — current state of the whole repository: [`STATUS.md`](STATUS.md).

---

## Legend

| Icon | Meaning |
|------|---------|
| 🟢 | Code-only change — no infra or external service needed |
| 🔵 | Infrastructure / config change |
| 🟡 | Needs an external service or third-party integration |
| ✅ | Done |
| ⚠️ | Partly done |
| 🔲 | To do |

---

## Priority 1 — Load Balancing & High Availability

### ⚠️ 🔵 Multi-Instance Deployment (Load-Balanced API + Workers)

**Status**: verified in a load-test topology — N API replicas and M workers behind an nginx load
balancer (`infra/loadtest/`). With identical load, 2 APIs + 2 workers admitted and completed every
run with p50 2.6 s, while 1 + 1 refused 14 % of runs and reached p50 20.5 s; nginx split requests
50.1 % / 49.9 %. Remaining: the same topology for the hosted deployment.

**Gap**: `docker-compose.yml` runs a single `api` and single `worker` service. No `deploy.replicas` or multiple upstream servers. Nginx only proxies to one API instance.

**What to do**:
1. Add `deploy.replicas: 2` to the `api` service in `docker-compose.yml` (L34-65).
2. Add `deploy.replicas: 2` to the `worker` service.
3. Update the Nginx config (`infra/docker/web.Dockerfile` → `nginx.conf`) with an `upstream api_pool` block that uses Docker's DNS-based load balancing:
   ```nginx
   upstream api_pool {
     least_conn;
     server api:8080;
     # Docker Compose DNS resolves all replicas automatically
   }
   ```
4. Replace `proxy_pass http://api:8080` with `proxy_pass http://api_pool`.
5. Add `ip_hash` or `least_conn` directive for SSE-friendly sticky routing (optional, since the API is stateless).

**Files to change**:
- `docker-compose.yml` — add replica counts
- `infra/docker/nginx.conf` (or the web Dockerfile) — add upstream block

**Effort**: Small

---

### ✅ 🔵 SSE-Friendly Load Balancer Timeouts

**Status**: `infra/loadtest/nginx-lb.conf` — upstream pool with `least_conn`, HTTP/1.1 keep-alive,
buffering off, 1 h read timeout and retry on another replica for failed idempotent requests.

**Gap**: Nginx has `proxy_read_timeout 1h` (correct), but it's not in a multi-upstream LB config yet. Once the upstream block is added, verify:

**What to do**:
1. Ensure these directives exist in the `location /` block that proxies to the API:
   ```nginx
   proxy_buffering off;
   proxy_cache off;
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   proxy_http_version 1.1;
   proxy_set_header Connection '';
   ```
2. The API already sets `x-accel-buffering: no` on SSE streams (`apps/api/src/sse.ts`), which is correct.

**Effort**: Trivial (part of the load balancing change)

---

## Priority 2 — Edge Rate Limiting & WAF

### 🔲 🔵 Nginx Per-IP Rate Limiting

**Gap**: No `limit_req_zone` in `nginx.conf`. All rate limiting is at the API layer — if the API is overwhelmed, Nginx can't protect it.

**What to do**:
1. Add to the `http` block in `nginx.conf`:
   ```nginx
   limit_req_zone $binary_remote_addr zone=perip:10m rate=60r/s;
   limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
   limit_req_status 429;
   ```
2. Apply to API proxy location:
   ```nginx
   location /api/ {
     limit_req zone=perip burst=30 nodelay;
     proxy_pass http://api_pool;
   }
   location /api/auth/ {
     limit_req zone=login burst=3 nodelay;
     proxy_pass http://api_pool;
   }
   ```
3. Add a custom 429 error page with `Retry-After` header.

**Files to change**:
- `infra/docker/nginx.conf` or web Dockerfile's Nginx config

**Effort**: Small

---

### 🔲 🟡 Web Application Firewall (WAF)

**Gap**: No WAF rules anywhere in the codebase.

**What to do**:
1. **Option A (recommended for production)**: Deploy behind Cloudflare (free tier available) or AWS WAF — handles OWASP Top 10, bot protection, and DDoS mitigation without code changes.
2. **Option B (self-hosted)**: Add ModSecurity module to Nginx with the OWASP Core Rule Set:
   ```nginx
   load_module modules/ngx_http_modsecurity_module.so;
   modsecurity on;
   modsecurity_rules_file /etc/nginx/modsecurity/modsecurity.conf;
   ```
3. Minimum rules to enable: SQL injection, XSS, path traversal, request size limits.

**Files to change**:
- `infra/docker/web.Dockerfile` — install ModSecurity module
- New file: `infra/nginx/modsecurity.conf` — ruleset config

**Effort**: Medium

---

## Priority 3 — Fault Tolerance

### ✅ 🟢 Checkpoint & Resume for Mid-Run Recovery

**Status**: Done as *durable steps* (`infra/migrations/0013_run_steps.sql`,
`packages/orchestrator/src/execution.ts`): every completed model call is checkpointed under a
content-addressed key; a resumed attempt keeps its first plan, replays checkpoints without calling
or billing the provider again, and reuses recorded tool results. Verified by
`apps/api/test/integration/durable-steps.test.ts` (worker killed mid-answer, run resumes). The
original proposal below (a single linear checkpoint) was replaced by per-step keys, which also work
for parallel strategies.

**Gap** (original): Events are persisted incrementally, but there's no mechanism to resume an orchestration from a checkpoint. A retried run starts from the beginning.

**What to do**:
1. Define a `RunCheckpoint` schema in `packages/contracts/`:
   ```ts
   type RunCheckpoint = {
     runId: string;
     stepIndex: number;
     completedToolCalls: string[];      // tool call IDs already executed
     accumulatedMessages: Message[];    // conversation so far
     lastEventId: number;              // resume from this event
   };
   ```
2. In the run processor (`packages/orchestrator/src/processor.ts`), save a checkpoint to the DB after each completed tool call / step.
3. On retry (when `run.attempt > 1`), load the latest checkpoint and:
   - Skip already-completed steps
   - Resume the orchestration loop from `stepIndex`
   - Re-attach accumulated context
4. Add a `run_checkpoints` table via a new migration in `infra/migrations/`.
5. Clean up checkpoints when a run completes or fails permanently.

**Files to change**:
- New: `infra/migrations/008_run_checkpoints.sql`
- `packages/orchestrator/src/processor.ts` — save/load checkpoints
- `packages/db/src/runs.ts` — add checkpoint repo methods
- `packages/contracts/src/runs.ts` — add checkpoint type

**Effort**: Large

---

### 🔲 🔵 Redis High Availability (Sentinel or Cluster)

**Gap**: Single Redis instance in `docker-compose.yml`. If Redis goes down, the entire system loses rate limiting, queue processing, pub/sub events, and circuit breaker state.

**What to do**:
1. **Option A — Redis Sentinel** (simpler, recommended for single-node deployments):
   - Add 3 Redis Sentinel containers to `docker-compose.yml`
   - Update `REDIS_URL` to use Sentinel protocol: `redis+sentinel://sentinel1:26379,sentinel2:26379/mymaster`
   - Update `ioredis` connections in `packages/bus/` to use Sentinel config
2. **Option B — Redis Cluster** (for multi-node production):
   - Add 6 Redis nodes (3 masters + 3 replicas) to Compose
   - Use cluster-aware ioredis connections
3. Ensure BullMQ queue connections handle failover (BullMQ supports Sentinel natively).

**Files to change**:
- `docker-compose.yml` — add Sentinel/cluster services
- `packages/bus/src/redis.ts` (or wherever Redis connections are created) — Sentinel config
- `.env.example` — document Sentinel URL format

**Effort**: Medium

---

### 🔲 🔵 Database Backups & WAL Archiving

**Gap**: No backup scripts, no WAL archiving configuration.

**What to do**:
1. Add a `pg_dump`-based backup script:
   ```bash
   #!/bin/bash
   # infra/scripts/backup.sh
   pg_dump -Fc -h postgres -U neuroflow neuroflow > /backups/neuroflow_$(date +%Y%m%d_%H%M%S).dump
   find /backups -name "*.dump" -mtime +7 -delete  # retain 7 days
   ```
2. Add a backup service to `docker-compose.yml`:
   ```yaml
   backup:
     image: postgres:17-alpine
     volumes:
       - ./infra/scripts:/scripts
       - backups:/backups
     entrypoint: ["/bin/sh", "-c", "while true; do /scripts/backup.sh; sleep 86400; done"]
     depends_on:
       postgres: { condition: service_healthy }
   ```
3. For WAL archiving (point-in-time recovery), add to Postgres config:
   ```
   archive_mode = on
   archive_command = 'cp %p /backups/wal/%f'
   ```
4. Document restore procedure in the README or a new `docs/disaster-recovery.md`.

**Files to change**:
- New: `infra/scripts/backup.sh`
- `docker-compose.yml` — add backup service and volume
- New: `docs/disaster-recovery.md`

**Effort**: Small

---

## Priority 4 — Observability

### ⚠️ 🟡 Grafana Dashboards & Prometheus Alerts

**Status**: alerting exists without dashboards — `GET /status` (503 on no live worker, stuck queue,
database/Redis down or no provider) polled by the `Uptime` GitHub Actions workflow, which opens and
closes an incident issue. Dashboards and metric-based alerts (latency, error rate, cost) remain.

**Gap**: 12 custom OpenTelemetry metrics are emitted (`packages/observability/src/telemetry.ts`), but no dashboards or alerts consume them.

**What to do**:
1. Add Prometheus + Grafana to `docker-compose.yml`:
   ```yaml
   prometheus:
     image: prom/prometheus:latest
     volumes:
       - ./infra/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
     ports:
       - "9090:9090"
   grafana:
     image: grafana/grafana:latest
     volumes:
       - ./infra/monitoring/dashboards:/var/lib/grafana/dashboards
       - ./infra/monitoring/provisioning:/etc/grafana/provisioning
     ports:
       - "3000:3000"
   ```
2. Create dashboard JSON files for:
   - **API Health**: request rate, error rate, latency p50/p95/p99
   - **Queue Health**: queue depth, processing time, stalled jobs
   - **Model Gateway**: model latency, token usage, circuit breaker state, fallback rate
   - **Rate Limiting**: 429s per tenant, daily token usage vs quota
3. Create Alertmanager rules:
   - Queue depth > 100 for > 5 min
   - Error rate > 5% for > 2 min
   - Circuit breaker open for > 5 min
   - Daily token usage > 90% of quota

**Files to create**:
- `infra/monitoring/prometheus.yml`
- `infra/monitoring/dashboards/*.json`
- `infra/monitoring/provisioning/dashboards.yml`
- `infra/monitoring/alertmanager.yml`

**Effort**: Medium

---

### ✅ 🟡 Error Tracking (Sentry)

**Status**: `packages/observability/src/errors.ts` — a Sentry envelope reporter (no SDK, so no
second OpenTelemetry pipeline) used by the API (5xx, crashes) and the worker (actionable run
failures, job and worker errors), with credential redaction, de-duplication and a rate cap.
Enabled by `SENTRY_DSN`. Frontend error reporting is not wired yet.

**Gap**: No Sentry or equivalent error tracking integration.

**What to do**:
1. Install Sentry Node SDK: `pnpm add @sentry/node` in `apps/api` and `apps/worker`.
2. Initialize in bootstrap:
   ```ts
   import * as Sentry from '@sentry/node';
   Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
   ```
3. Add Sentry Fastify plugin for automatic error capture in the API.
4. Add Sentry to the worker's error handler for failed jobs.
5. Tag errors with `workspaceId`, `runId`, `userId` for filtering.
6. Add `SENTRY_DSN` to `.env.example`.

**Files to change**:
- `apps/api/src/bootstrap.ts` — initialize Sentry
- `apps/worker/src/main.ts` — initialize Sentry
- `apps/api/src/app.ts` — add Sentry Fastify error handler
- `.env.example` — add `SENTRY_DSN`

**Effort**: Small

---

## Priority 5 — Data Scaling

### 🔲 🔵 PgBouncer Connection Pooling

**Gap**: Direct `pg.Pool` with `max: 20` (`apps/api/src/bootstrap.ts`). No external connection pooler.

**What to do**:
1. Add PgBouncer to `docker-compose.yml`:
   ```yaml
   pgbouncer:
     image: edoburu/pgbouncer:latest
     environment:
       DB_USER: neuroflow
       DB_PASSWORD: ${POSTGRES_PASSWORD:-neuroflow}
       DB_HOST: postgres
       DB_NAME: neuroflow
       POOL_MODE: transaction
       MAX_CLIENT_CONN: 200
       DEFAULT_POOL_SIZE: 20
     ports:
       - "6432:6432"
     depends_on:
       postgres: { condition: service_healthy }
   ```
2. Point `DATABASE_URL` in the API and worker services to PgBouncer (`postgres://neuroflow:xxx@pgbouncer:6432/neuroflow`).
3. Reduce `pg.Pool` max to 5 (PgBouncer handles the pooling now).
4. Keep the direct Postgres URL for migrations (PgBouncer in transaction mode doesn't support `CREATE INDEX CONCURRENTLY`, etc.).

**Files to change**:
- `docker-compose.yml` — add PgBouncer service
- `docker-compose.yml` — update `DATABASE_URL` for api/worker services
- `.env.example` — document the setup

**Effort**: Small

---

### 🔲 🔵 Event Table Partitioning & Retention

**Gap**: No `PARTITION BY` in migration files. No event/run retention or archival. The `run_events` table will grow unbounded.

**What to do**:
1. Create a migration to partition `run_events` by range on `created_at`:
   ```sql
   -- 008_partition_events.sql
   ALTER TABLE run_events RENAME TO run_events_old;
   CREATE TABLE run_events (LIKE run_events_old INCLUDING ALL)
     PARTITION BY RANGE (created_at);
   CREATE TABLE run_events_default PARTITION OF run_events DEFAULT;
   INSERT INTO run_events SELECT * FROM run_events_old;
   DROP TABLE run_events_old;
   ```
2. Add a cron job / scheduled task to:
   - Create new monthly partitions ahead of time
   - Drop or archive partitions older than the retention period (e.g., 90 days)
3. Add retention configuration:
   ```
   EVENT_RETENTION_DAYS=90
   RUN_RETENTION_DAYS=180
   ```
4. Create a reconciler task that periodically cleans up old runs and their events.

**Files to create**:
- `infra/migrations/008_partition_events.sql`
- `infra/scripts/partition_maintenance.sh`

**Effort**: Medium

---

### 🔲 🔵 Read Replica Support

**Gap**: Single `DATABASE_URL` throughout. All reads and writes go to one Postgres instance.

**What to do**:
1. Add a `DATABASE_READ_URL` environment variable.
2. Create a read-only `pg.Pool` in the bootstrap:
   ```ts
   const readPool = new Pool({ connectionString: env.DATABASE_READ_URL || env.DATABASE_URL });
   ```
3. Update repo modules in `packages/db/src/` to accept a `readPool` parameter for read queries.
4. Route heavy read queries (list runs, search events, conversation history) to the read pool.
5. Keep all writes on the primary pool.

**Files to change**:
- `apps/api/src/bootstrap.ts` — create read pool
- `packages/db/src/*.ts` — add read pool parameter to read-heavy queries
- `.env.example` — document `DATABASE_READ_URL`

**Effort**: Medium (many repo modules to update)

---

## Priority 6 — Caching

### 🔲 🟢 Model List & Settings Caching

**Gap**: `listModels()` rebuilds the list on every call. `refreshHealth()` runs every 30s but model lists aren't cached separately.

**What to do**:
1. Add a TTL cache (30-60s) around `listModels()` in the gateway:
   ```ts
   private modelListCache: { data: ModelInfo[]; expiresAt: number } | null = null;

   listModels(): ModelInfo[] {
     if (this.modelListCache && Date.now() < this.modelListCache.expiresAt) {
       return this.modelListCache.data;
     }
     const list = this.buildModelList();
     this.modelListCache = { data: list, expiresAt: Date.now() + 30_000 };
     return list;
   }
   ```
2. Invalidate the cache when provider health changes (in `refreshHealth()`).

**Files to change**:
- `packages/models/src/gateway.ts` — add model list cache

**Effort**: Small

---

### ⚠️ 🔵 CDN for Static Assets

**Status**: the marketing site and the web app are configured for Vercel (`apps/*/vercel.json`),
which serves them from its CDN. Self-hosted deployments behind Nginx still have no CDN.

**Gap**: Nginx serves `/assets/` with `Cache-Control: immutable`, but there's no actual CDN.

**What to do**:
1. **Option A — Cloudflare** (free, recommended): Point DNS to Cloudflare, enable caching for static assets. The existing `Cache-Control: immutable` header means Cloudflare will cache indefinitely.
2. **Option B — CloudFront**: Create a CloudFront distribution with the Nginx origin, cache `/assets/*` and `/screens/*`.
3. In both cases, no code changes needed — the existing immutable headers are sufficient.

**Effort**: Small (infra config only)

---

## Priority 7 — Back-Pressure

### 🔲 🔵 Worker Autoscaling on Queue Depth

**Gap**: `queue.stats()` exposes `waiting` and `active` per queue (`packages/bus/src/queue.ts`), but no autoscaler consumes it.

**What to do**:
1. **Option A — Docker Compose** (for single-server):
   - Create a simple autoscaler script that polls `queue.stats()` via a health endpoint
   - Scale workers with `docker compose up -d --scale worker=N`
2. **Option B — Kubernetes** (for production):
   - Add a KEDA `ScaledObject` that reads queue depth from Redis
   - Scale the worker deployment based on the `neuroflow-runs:waiting` metric
3. **Option C — Manual** (simplest):
   - Add a `/metrics` endpoint that exposes queue depth as Prometheus metrics
   - Use Grafana alerts to notify when queue depth exceeds threshold
   - Human scales workers manually

**Files to create**:
- `infra/scripts/autoscale.sh` (Option A)
- `infra/k8s/keda-scaler.yaml` (Option B)
- Expose queue stats via the existing health endpoint (shared)

**Effort**: Medium

---

## Priority 8 — CI/CD

### ⚠️ 🔵 Continuous Deployment Pipeline

**Status**: Vercel (site, web) and Railway (API) can deploy from Git pushes, but deploys are not
gated on CI, there is no staging environment and no smoke tests after deploy.

**Gap**: CI builds Docker images (`.github/workflows/ci.yml`) but doesn't push or deploy them. No CD workflow exists.

**What to do**:
1. Add a CD workflow (`.github/workflows/cd.yml`) triggered on push to `main`:
   ```yaml
   - Log in to container registry (GHCR / Docker Hub / ECR)
   - Build and push tagged images (api, worker, web)
   - Deploy to staging (docker compose pull + up, or kubectl apply)
   - Run smoke tests against staging
   - Promote to production (manual approval gate)
   ```
2. Add image tagging strategy: `latest` + `sha-<commit>` + `v<semver>` on tags.
3. Add environment secrets to GitHub: `REGISTRY_TOKEN`, `DEPLOY_SSH_KEY` or equivalent.
4. Add a rollback mechanism (pin to previous image tag).

**Files to create**:
- `.github/workflows/cd.yml`
- `infra/scripts/deploy.sh`

**Effort**: Medium

---

## Priority 9 — LLM Rate Limiting

### ✅ 🟢 Per-Key Monetary Spend Caps

**Status**: Done as dollar budgets (`packages/bus/src/budgets.ts`, migration 0010): daily and
monthly workspace limits and a monthly budget per workspace provider key, checked at run admission
and before every model call; alerts as audit events and webhooks.

**Gap** (original): Daily token quota exists per workspace, but no per-key monetary spend cap.

**What to do**:
1. Add `dailySpendCapUsd` to provider config in `packages/models/src/factory.ts`.
2. Track cumulative cost per key per day (using the existing Redis rate limiter infrastructure).
3. In `gateway.admit()`, check spend cap before allowing a request through.
4. Add `MODEL_KEY_DAILY_SPEND_CAP` to `.env.example`.

**Files to change**:
- `packages/models/src/factory.ts` — parse spend cap from env
- `packages/models/src/gateway.ts` — check spend cap in `admit()`
- `.env.example` — document the setting

**Effort**: Small

---

## Already Done (Audit Corrections)

These items were listed as "still to build" in the design doc, but the code already implements them:

| Item | Where |
|------|-------|
| ✅ Shared Redis-backed token bucket for model providers | `packages/bus/src/rate-limit.ts` — `RedisRateLimiter` with Lua scripts |
| ✅ Circuit breaker per provider (closed/open/half-open) | `packages/models/src/circuit-breaker.ts` |
| ✅ Rate limits by plan and route classification | `packages/contracts/src/plan-limits.ts` + `apps/api/src/rate-limit.ts` |
| ✅ Separate queues with priorities + per-tenant fairness | `packages/bus/src/queue.ts` (3 queues) + `apps/worker/src/workers.ts` (Redis semaphore) |
| ✅ Concurrency semaphore per provider with TTL & heartbeat | `packages/bus/src/rate-limit.ts` (`tryAcquireSlot`) |
| ✅ CI: typecheck, lint, unit, integration, E2E, image builds | `.github/workflows/ci.yml` |
| ✅ Static hosting for the site and web app (Vercel CDN) | `apps/site/vercel.json`, `apps/web/vercel.json` |
| ✅ API build/start on Railway | `nixpacks.toml` |

---

## Quick Reference

| # | Item | Type | Effort | Status |
|---|------|------|--------|--------|
| 1 | Multi-instance deployment (LB) | 🔵 Infra | Small | ⚠️ verified in load test |
| 2 | Edge rate limiting (Nginx) | 🔵 Infra | Small | 🔲 |
| 3 | WAF | 🟡 External | Medium | 🔲 |
| 4 | Checkpoint/resume mid-run | 🟢 Code | Large | 🔲 |
| 5 | Redis HA (Sentinel/Cluster) | 🔵 Infra | Medium | 🔲 |
| 6 | Database backups | 🔵 Infra | Small | 🔲 |
| 7 | Grafana dashboards + alerts | 🟡 External | Medium | ⚠️ /status + uptime alerts |
| 8 | Sentry error tracking | 🟡 External | Small | ✅ backend |
| 9 | PgBouncer connection pooling | 🔵 Infra | Small | 🔲 |
| 10 | Event partitioning + retention | 🔵 DB | Medium | 🔲 |
| 11 | Read replica support | 🔵 Infra | Medium | 🔲 |
| 12 | Model list caching | 🟢 Code | Small | 🔲 |
| 13 | CDN for static assets | 🔵 Infra | Small | ⚠️ Vercel for site/web |
| 14 | Worker autoscaling | 🔵 Infra | Medium | 🔲 |
| 15 | CD pipeline | 🔵 CI/CD | Medium | ⚠️ Git deploys, no CI gate |
| 16 | Per-key spend caps | 🟢 Code | Small | 🔲 |
| 17 | SSE-friendly LB timeouts | 🔵 Infra | Trivial | ✅ |
