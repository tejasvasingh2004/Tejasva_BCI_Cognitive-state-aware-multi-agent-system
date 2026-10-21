import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createErrorReporter, parseDsn, parseStack, redact } from '../src/errors';

/** A stand-in Sentry ingestion endpoint that records envelopes. */
let server: Server;
let base: string;
const received: Array<{ url: string; auth: string; lines: unknown[] }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        auth: String(req.headers['x-sentry-auth'] ?? ''),
        lines: body.trim().split('\n').map((l) => JSON.parse(l) as unknown),
      });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  received.length = 0;
});

type Event = { level: string; tags: Record<string, unknown>; extra: Record<string, unknown>; release?: string; environment?: string; exception: { values: Array<{ type: string; value: string; stacktrace?: { frames: Array<{ filename: string; in_app: boolean }> } }> } };

describe('error reporter', () => {
  it('is a no-op without a DSN', () => {
    const r = createErrorReporter({ service: 'test' });
    expect(r.enabled).toBe(false);
    r.capture(new Error('ignored'));
  });

  it('sends a Sentry envelope with the error chain, tags and release, and no secrets', async () => {
    const r = createErrorReporter({ dsn: `${base.replace('//', '//pubkey@')}/42`, service: 'neuroflow-api', environment: 'production', release: 'abc123' });
    const cause = new Error('connect ECONNREFUSED postgres://neuroflow:s3cret@db:5432/neuroflow');
    const err = new Error('request failed with Bearer gsk_abcdefghijklmnop1234', { cause });
    r.capture(err, { tags: { route: '/v1/runs', status: 500 }, extra: { requestId: 'req-1', token: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa' } });
    await r.flush();

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/api/42/envelope/');
    expect(received[0]!.auth).toContain('sentry_key=pubkey');
    const [header, item, event] = received[0]!.lines as [Record<string, unknown>, Record<string, unknown>, Event];
    expect(item).toEqual({ type: 'event' });
    expect(header.event_id).toBe((event as unknown as { event_id: string }).event_id);
    expect(event).toMatchObject({ level: 'error', environment: 'production', release: 'abc123', tags: { service: 'neuroflow-api', route: '/v1/runs', status: 500 } });
    // Root cause first, then the error that wrapped it.
    expect(event.exception.values.map((v) => v.value)).toEqual([
      'connect ECONNREFUSED postgres://[redacted]@db:5432/neuroflow',
      'request failed with Bearer [redacted]',
    ]);
    expect(event.extra).toEqual({ requestId: 'req-1', token: 'gh_[redacted]' });
    const raw = JSON.stringify(received[0]!.lines);
    expect(raw).not.toContain('s3cret');
    expect(raw).not.toContain('gsk_abcdefghijklmnop1234');
    expect(event.exception.values[1]!.stacktrace!.frames.at(-1)!.filename).toContain('errors.test.ts');
  });

  it('reports an identical error once per window and caps events per minute', async () => {
    let t = 1_000_000;
    const r = createErrorReporter({ dsn: `${base.replace('//', '//k@')}/1`, service: 's', maxPerMinute: 3, now: () => t });
    const same = () => new Error('same failure');
    for (let i = 0; i < 5; i++) r.capture(same());
    await r.flush();
    // All five come from the same line, so they share a fingerprint.
    expect(received).toHaveLength(1);

    for (let i = 0; i < 10; i++) r.capture(new Error(`distinct ${i}`));
    await r.flush();
    expect(received).toHaveLength(3); // 1 + 2 more until the per-minute cap of 3

    t += 61_000;
    r.capture(same());
    await r.flush();
    expect(received).toHaveLength(4); // new minute, dedupe window over
  });

  it('never throws when the endpoint is down', async () => {
    const r = createErrorReporter({ dsn: 'http://k@127.0.0.1:1/9', service: 's' });
    expect(() => r.capture(new Error('x'))).not.toThrow();
    await r.flush(3_000);
  });
});

describe('helpers', () => {
  it('parses DSNs, including self-hosted path prefixes', () => {
    expect(parseDsn('https://abc@o1.ingest.sentry.io/123')).toEqual({ endpoint: 'https://o1.ingest.sentry.io/api/123/envelope/', publicKey: 'abc' });
    expect(parseDsn('https://abc@sentry.example.com/sentry/7')).toEqual({ endpoint: 'https://sentry.example.com/sentry/api/7/envelope/', publicKey: 'abc' });
    expect(() => parseDsn('https://sentry.io/1')).toThrow();
  });

  it('redacts common credential formats', () => {
    expect(redact('key nf_live_abcdefghijklmnop and sk-proj-abcdefghijk')).toBe('key nf_[redacted] and sk-[redacted]');
    expect(redact('github_pat_11ABCDEFGHIJKLMNOPQRST_x')).toBe('github_pat_[redacted]');
    expect(redact('https://api.example.com/x?api_key=123&b=2')).toBe('https://api.example.com/x?api_key=[redacted]&b=2');
    expect(redact('redis://default:pw@upstash.io:6379')).toBe('redis://[redacted]@upstash.io:6379');
  });

  it('turns V8 stacks into frames, oldest first, marking library code', () => {
    const frames = parseStack(['Error: x', '    at handler (/app/dist/main.js:10:5)', '    at /app/node_modules/fastify/lib/route.js:20:3', '    at node:internal/process/task_queues:95:5'].join('\n'));
    expect(frames.map((f) => [f.filename, f.in_app])).toEqual([
      ['node:internal/process/task_queues', false],
      ['/app/node_modules/fastify/lib/route.js', false],
      ['/app/dist/main.js', true],
    ]);
  });
});
