/* global __ENV, __VU, __ITER */
// k6 load test for NeuroFlow behind the load balancer (see infra/loadtest/run.sh).
//
// Two scenarios at fixed arrival rates, so the offered load is the same for every topology:
// - reads: authenticated API reads (models, usage) — measures the API tier;
// - runs:  create a run, then poll it until it finishes — measures API → queue → worker → model →
//          persistence end to end. Admission rejections (429/503) are counted, not hidden.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://lb';
const KEYS = (__ENV.API_KEYS || '').split(',').filter(Boolean);
const READ_RATE = Number(__ENV.READ_RATE || 100);
const RUN_RATE = Number(__ENV.RUN_RATE || 5);
const DURATION = __ENV.DURATION || '60s';
const RUN_TIMEOUT_MS = Number(__ENV.RUN_TIMEOUT_MS || 120000);

if (!KEYS.length) throw new Error('API_KEYS is required');

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    reads: { executor: 'constant-arrival-rate', exec: 'reads', rate: READ_RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 40, maxVUs: 300 },
    // gracefulStop lets every admitted run finish (or time out) so slow runs are counted, not dropped.
    runs: { executor: 'constant-arrival-rate', exec: 'runs', rate: RUN_RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 40, maxVUs: 1000, gracefulStop: '150s' },
  },
  thresholds: {
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    'http_req_duration{scenario:reads}': ['p(95)<500'],
    run_completed: ['rate>0.95'],
    // Declared so the per-scenario request count appears in the summary.
    'http_reqs{scenario:reads}': ['count>0'],
    'iterations{scenario:runs}': ['count>0'],
  },
};

const runEndToEnd = new Trend('run_end_to_end_ms', true);
const runCompleted = new Rate('run_completed');
const runAdmitted = new Rate('run_admitted');
const runRejected = new Counter('run_rejected');

const headers = (vu) => ({ authorization: `Bearer ${KEYS[vu % KEYS.length]}`, 'content-type': 'application/json' });

export function reads() {
  const h = { headers: headers(__VU) };
  const path = __ITER % 2 === 0 ? '/v1/models' : '/v1/workspace/usage';
  const res = http.get(`${BASE}${path}`, { ...h, tags: { name: path } });
  check(res, { 'read 200': (r) => r.status === 200 });
}

export function runs() {
  const h = headers(__VU);
  const started = Date.now();
  const created = http.post(`${BASE}/v1/runs`, JSON.stringify({ messages: [{ role: 'user', content: `load test ${__VU}-${__ITER}` }] }), {
    headers: h,
    tags: { name: 'POST /v1/runs' },
  });
  if (created.status === 429 || created.status === 503) {
    // Back-pressure working as designed: the run was refused, not lost.
    runAdmitted.add(false);
    runRejected.add(1);
    return;
  }
  const ok = check(created, { 'run accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202 });
  runAdmitted.add(ok);
  if (!ok) {
    runCompleted.add(false);
    return;
  }
  const id = created.json('run.id');
  while (Date.now() - started < RUN_TIMEOUT_MS) {
    sleep(0.5);
    const res = http.get(`${BASE}/v1/runs/${id}`, { headers: h, tags: { name: 'GET /v1/runs/:id' } });
    if (res.status !== 200) continue;
    const status = res.json('run.status');
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      runCompleted.add(status === 'completed');
      if (status === 'completed') runEndToEnd.add(Date.now() - started);
      return;
    }
  }
  runCompleted.add(false);
}

export function handleSummary(data) {
  const m = (name, stat) => data.metrics[name]?.values?.[stat];
  const summary = {
    topology: __ENV.TOPOLOGY || '',
    offered: { readsPerSecond: READ_RATE, runsPerSecond: RUN_RATE, duration: DURATION },
    reads: {
      requests: m('http_reqs{scenario:reads}', 'count'),
      p50Ms: m('http_req_duration{scenario:reads}', 'med'),
      p95Ms: m('http_req_duration{scenario:reads}', 'p(95)'),
      p99Ms: m('http_req_duration{scenario:reads}', 'p(99)'),
      errorRate: m('http_req_failed{scenario:reads}', 'rate'),
    },
    totalHttpRequests: m('http_reqs', 'count'),
    runs: {
      offered: m('iterations{scenario:runs}', 'count'),
      dropped: m('dropped_iterations', 'count') || 0,
      completedRate: m('run_completed', 'rate'),
      completed: m('run_completed', 'passes'),
      notCompleted: m('run_completed', 'fails'),
      admittedRate: m('run_admitted', 'rate'),
      rejected: m('run_rejected', 'count') || 0,
      endToEndP50Ms: m('run_end_to_end_ms', 'med'),
      endToEndP95Ms: m('run_end_to_end_ms', 'p(95)'),
      endToEndMaxMs: m('run_end_to_end_ms', 'max'),
    },
  };
  return {
    stdout: `\n${JSON.stringify(summary, null, 2)}\n`,
    [`/results/${__ENV.TOPOLOGY || 'run'}.json`]: JSON.stringify(summary, null, 2),
  };
}
