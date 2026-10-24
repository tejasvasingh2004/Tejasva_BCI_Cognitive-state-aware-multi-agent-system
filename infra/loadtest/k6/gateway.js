/* global __ENV, __VU, __ITER, console */
// k6 load test for gateway mode (single model calls streamed from the API, no queue), behind the
// load balancer (see infra/loadtest/run.sh, MODE=gateway).
//
// One scenario at a fixed arrival rate. Every response carries NeuroFlow's own measurement of the
// time between the request's arrival and the provider request (`server-timing: overhead;dur=…`);
// the roadmap gate is p95 overhead under 50 ms. Total time includes the (mock) model's ~1 s.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://lb';
const KEYS = (__ENV.API_KEYS || '').split(',').filter(Boolean);
const RATE = Number(__ENV.GATEWAY_RATE || 40);
const DURATION = __ENV.DURATION || '60s';
const MODEL = __ENV.GATEWAY_MODEL || 'qwen/qwen3:8b';

if (!KEYS.length) throw new Error('API_KEYS is required');

export const options = {
  // 'count' is listed so the gate can require real samples.
  summaryTrendStats: ['count', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    gateway: { executor: 'constant-arrival-rate', exec: 'gateway', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 60, maxVUs: 600, gracefulStop: '60s' },
  },
  thresholds: {
    gateway_overhead_ms: ['p(95)<50'],
    gateway_ok: ['rate>0.99'],
  },
};

const overhead = new Trend('gateway_overhead_ms', true);
const total = new Trend('gateway_total_ms', true);
const ok = new Rate('gateway_ok');
// Failures by kind, so a low success rate explains itself (plan rate limits, overload, errors).
const failures = { 429: new Counter('gateway_fail_429'), 503: new Counter('gateway_fail_503'), 5: new Counter('gateway_fail_5xx'), other: new Counter('gateway_fail_other') };
const seen = new Set();

export function gateway() {
  const res = http.post(
    `${BASE}/v1/chat/completions`,
    JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: `gateway load ${__VU}-${__ITER}` }], neuroflow: { gateway: true } }),
    { headers: { authorization: `Bearer ${KEYS[__VU % KEYS.length]}`, 'content-type': 'application/json' }, tags: { name: 'gateway' }, timeout: '60s' },
  );
  const good = check(res, { 'gateway 200': (r) => r.status === 200, 'gateway mode': (r) => r.headers['X-Neuroflow-Mode'] === 'gateway' });
  ok.add(good);
  if (!good) {
    const kind = res.status === 429 || res.status === 503 ? res.status : res.status >= 500 ? 5 : 'other';
    failures[kind].add(1);
    if (!seen.has(res.status)) {
      seen.add(res.status);
      console.warn(`gateway call failed: HTTP ${res.status} ${String(res.body).slice(0, 200)}`);
    }
    return;
  }
  const m = /overhead;dur=([\d.]+)/.exec(res.headers['Server-Timing'] || '');
  if (m) overhead.add(Number(m[1]));
  total.add(res.timings.duration);
}

export function handleSummary(data) {
  const m = (name, stat) => data.metrics[name]?.values?.[stat];
  const summary = {
    topology: __ENV.TOPOLOGY || '',
    mode: 'gateway',
    offered: { callsPerSecond: RATE, duration: DURATION, model: MODEL },
    calls: {
      requests: m('http_reqs', 'count'),
      okRate: m('gateway_ok', 'rate'),
      dropped: m('dropped_iterations', 'count') || 0,
      failed: {
        http429: m('gateway_fail_429', 'count') || 0,
        http503: m('gateway_fail_503', 'count') || 0,
        http5xx: m('gateway_fail_5xx', 'count') || 0,
        other: m('gateway_fail_other', 'count') || 0,
      },
    },
    overheadMs: {
      p50: m('gateway_overhead_ms', 'med'),
      p95: m('gateway_overhead_ms', 'p(95)'),
      p99: m('gateway_overhead_ms', 'p(99)'),
      max: m('gateway_overhead_ms', 'max'),
    },
    totalMs: { p50: m('gateway_total_ms', 'med'), p95: m('gateway_total_ms', 'p(95)') },
    // Passing needs real samples and successful calls, not just a low number.
    gatePassed: (m('gateway_overhead_ms', 'count') ?? 0) > 0 && (m('gateway_ok', 'rate') ?? 0) > 0.99 && m('gateway_overhead_ms', 'p(95)') < 50,
  };
  return {
    stdout: `\n${JSON.stringify(summary, null, 2)}\n`,
    [`/results/gateway-${__ENV.TOPOLOGY || 'run'}.json`]: JSON.stringify(summary, null, 2),
  };
}
