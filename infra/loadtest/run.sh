#!/usr/bin/env bash
# Horizontal-scaling load test: runs the same k6 load against each topology (API replicas x
# workers) behind an nginx load balancer, with a mock model provider (no provider tokens spent)
# and isolated, throw-away PostgreSQL/Redis volumes. Results land in infra/loadtest/results/.
#
#   infra/loadtest/run.sh                      # topologies 1x1 and 2x2, 60 s each
#   TOPOLOGIES="1x1 2x2 3x3" DURATION=90s RUN_RATE=6 infra/loadtest/run.sh
#
# Requires Docker (compose v2.24+) and Node 22 with the repo's dependencies installed.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PROJECT=neuroflow-loadtest
TOPOLOGIES=${TOPOLOGIES:-"1x1 2x2"}
TENANTS=${TENANTS:-8}
export DURATION=${DURATION:-60s} READ_RATE=${READ_RATE:-100} RUN_RATE=${RUN_RATE:-5}
export MOCK_PORT=${MOCK_PORT:-11500} LB_PORT=${LB_PORT:-8088} LOADTEST_PG_PORT=${LOADTEST_PG_PORT:-5434}
export WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-4}
K6_IMAGE=${K6_IMAGE:-grafana/k6:0.54.0}

# Throw-away credentials for this run only.
rand() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2'))"; }
export POSTGRES_PASSWORD="lt-$(rand 12 hex)"
export LOADTEST_SESSION_SECRET="$(rand 32 hex)"
export LOADTEST_SECRETS_KEY="$(rand 32 base64)"
TENANT_PASSWORD="$(rand 16 hex)"

COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f infra/loadtest/docker-compose.loadtest.yml --profile app)
RESULTS="$ROOT/infra/loadtest/results"
mkdir -p "$RESULTS"
# Docker on Windows needs Windows paths for bind mounts.
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

MOCK_PID=""
cleanup() {
  log "Cleaning up"
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "Starting the mock model provider on :$MOCK_PORT"
MOCK_PORT=$MOCK_PORT MOCK_HOST=0.0.0.0 node --import tsx packages/models/src/testing/serve.ts > "$RESULTS/mock-provider.log" 2>&1 &
MOCK_PID=$!
sleep 2

log "Building API and worker images"
"${COMPOSE[@]}" build api worker

KEYS=""
for topo in $TOPOLOGIES; do
  export API_REPLICAS=${topo%x*} WORKER_REPLICAS=${topo#*x}
  log "Topology $topo: $API_REPLICAS API replica(s), $WORKER_REPLICAS worker(s) x concurrency $WORKER_CONCURRENCY"
  "${COMPOSE[@]}" up -d --wait --scale "api=$API_REPLICAS" --scale "worker=$WORKER_REPLICAS" lb worker
  # nginx resolves the API replicas at start-up: restart it once they are all healthy.
  "${COMPOSE[@]}" restart lb >/dev/null

  if [ -z "$KEYS" ]; then
    log "Creating $TENANTS enterprise tenants"
    export DATABASE_URL="postgres://neuroflow:${POSTGRES_PASSWORD}@localhost:${LOADTEST_PG_PORT}/neuroflow"
    for i in $(seq 1 "$TENANTS"); do
      email="tenant$i@loadtest.local"
      NEUROFLOW_PASSWORD="$TENANT_PASSWORD" pnpm -s --filter @neuroflow/db cli create-user --email "$email" --name "Tenant $i" >/dev/null
      pnpm -s --filter @neuroflow/db cli set-plan --email "$email" --plan enterprise >/dev/null
      key=$(pnpm -s --filter @neuroflow/db cli create-api-key --email "$email" --name loadtest | sed -n 's/^API key (shown once): //p')
      KEYS="${KEYS:+$KEYS,}$key"
    done
    unset DATABASE_URL
  fi

  "${COMPOSE[@]}" exec -T lb sh -c ': > /var/log/nginx/upstream.log'

  log "Running k6 ($DURATION: $READ_RATE reads/s + $RUN_RATE runs/s)"
  MSYS_NO_PATHCONV=1 docker run --rm --network "${PROJECT}_default" \
    -v "$(host_path "$ROOT/infra/loadtest/k6"):/scripts:ro" -v "$(host_path "$RESULTS"):/results" \
    -e BASE_URL=http://lb -e API_KEYS="$KEYS" -e TOPOLOGY="$topo" \
    -e DURATION -e READ_RATE -e RUN_RATE \
    "$K6_IMAGE" run --quiet /scripts/load.js || true

  log "Requests per API replica during the test"
  "${COMPOSE[@]}" exec -T lb sh -c 'sort /var/log/nginx/upstream.log | uniq -c' | tee "$RESULTS/$topo-balance.txt"

  "${COMPOSE[@]}" stop api worker lb >/dev/null
done

log "Results"
for topo in $TOPOLOGIES; do echo "--- $topo"; cat "$RESULTS/$topo.json" 2>/dev/null || echo "(no result)"; done
