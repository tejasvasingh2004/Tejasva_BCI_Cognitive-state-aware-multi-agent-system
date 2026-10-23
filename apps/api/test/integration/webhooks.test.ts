import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebhookPayload, WebhooksResponse } from '@neuroflow/contracts';
import { verifyWebhook, WebhookDeliverer } from '@neuroflow/bus';
import { auditRepo } from '@neuroflow/db';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { api, readSse, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();

/** Webhooks and async runs end to end: register → run → signed delivery from the worker. */
describe.skipIf(!reachable)('webhooks and async runs', () => {
  let h: Harness;
  let receiver: Server;
  let base: string;
  let deliverer: WebhookDeliverer;
  const received: { path: string; headers: IncomingMessage['headers']; body: string }[] = [];

  const waitFor = async (pred: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out waiting for a webhook');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    h = await startHarness({ WEBHOOK_ALLOW_PRIVATE: 'true' });
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    deliverer = new WebhookDeliverer(h.db.pool, h.runtime.webhooks, { allowPrivate: true, intervalMs: 50 });
    deliverer.start();
  }, 60_000);
  afterAll(async () => {
    await deliverer?.stop();
    receiver?.close();
    await h?.close();
  });

  it('registers an endpoint and creates the signing secret', async () => {
    const bad = await api(h, '/v1/webhooks', { method: 'POST', json: { url: 'https://user:pw@example.com/x' } });
    expect(bad.status).toBe(400);
    const res = await api(h, '/v1/webhooks', { method: 'POST', json: { url: `${base}/endpoint`, eventTypes: ['run.completed', 'run.failed'] } });
    expect(res.status).toBe(201);
    const list = (await (await api(h, '/v1/webhooks')).json()) as WebhooksResponse;
    expect(list.endpoints).toHaveLength(1);
    expect(list.secret?.hint).toHaveLength(4);
    expect(list.eventTypes).toContain('run.approval_requested');
  });

  it('posts a signed run.completed with the output to the endpoint and to the run’s own webhookUrl', async () => {
    const { secret } = await (await api(h, '/v1/webhooks/secret')).json();
    expect(secret).toMatch(/^whsec_/);
    const create = await api(h, '/v1/runs', {
      method: 'POST',
      json: { agentStrategy: 'direct', webhookUrl: `${base}/callback`, metadata: { order: 42 }, messages: [{ role: 'user', content: 'async run please' }] },
    });
    expect(create.status).toBe(201);
    const runId = (await create.json()).run.id as string;

    await waitFor(() => received.filter((r) => JSON.parse(r.body).data?.run?.id === runId).length >= 2);
    const deliveries = received.filter((r) => JSON.parse(r.body).data?.run?.id === runId);
    expect(deliveries.map((d) => d.path).sort()).toEqual(['/callback', '/endpoint']);
    for (const d of deliveries) {
      const ok = verifyWebhook(secret, { id: String(d.headers['webhook-id']), timestamp: String(d.headers['webhook-timestamp']), signature: String(d.headers['webhook-signature']) }, d.body);
      expect(ok).toBe(true);
      const payload = JSON.parse(d.body) as WebhookPayload;
      expect(payload).toMatchObject({ type: 'run.completed', data: { run: { id: runId, status: 'completed', metadata: { order: 42 } } } });
      expect(String((payload.data.run as { output: string }).output)).toContain('async run please');
    }
    const log = (await (await api(h, '/v1/webhooks/deliveries')).json()).deliveries as Array<{ runId: string; status: string }>;
    expect(log.filter((d) => d.runId === runId).every((d) => d.status === 'delivered')).toBe(true);
  });

  it('refuses an unsafe webhookUrl when the run is created', async () => {
    const res = await api(h, '/v1/runs', { method: 'POST', json: { webhookUrl: 'ftp://example.com/x', messages: [{ role: 'user', content: 'x' }] } });
    expect(res.status).toBe(400);
  });

  it('sends a test delivery, rotates the secret (both secrets sign for a day) and audits secret access', async () => {
    const [endpoint] = ((await (await api(h, '/v1/webhooks')).json()) as WebhooksResponse).endpoints;
    const { secret: old } = await (await api(h, '/v1/webhooks/secret')).json();
    const { secret: fresh } = await (await api(h, '/v1/webhooks/secret/rotate', { method: 'POST' })).json();
    expect(fresh).not.toBe(old);
    received.length = 0;
    expect((await api(h, `/v1/webhooks/${endpoint!.id}/test`, { method: 'POST' })).status).toBe(202);
    await waitFor(() => received.length > 0);
    const d = received[0]!;
    expect(JSON.parse(d.body).type).toBe('webhook.test');
    const headers = { id: String(d.headers['webhook-id']), timestamp: String(d.headers['webhook-timestamp']), signature: String(d.headers['webhook-signature']) };
    expect(headers.signature.split(' ')).toHaveLength(2);
    expect(verifyWebhook(fresh, headers, d.body)).toBe(true);
    expect(verifyWebhook(old, headers, d.body)).toBe(true);

    const actions = (await auditRepo.list(h.db.pool, (await h.db.pool.query('SELECT workspace_id FROM webhook_endpoints LIMIT 1')).rows[0].workspace_id, { limit: 50 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['webhook.created', 'webhook.secret_revealed', 'webhook.secret_rotated']));
  });

  it('can switch an endpoint off and delete it', async () => {
    const [endpoint] = ((await (await api(h, '/v1/webhooks')).json()) as WebhooksResponse).endpoints;
    const off = await (await api(h, `/v1/webhooks/${endpoint!.id}`, { method: 'PATCH', json: { enabled: false } })).json();
    expect(off.endpoint.enabled).toBe(false);
    expect((await api(h, `/v1/webhooks/${endpoint!.id}`, { method: 'DELETE' })).status).toBe(204);
    // Run events still stream as before for clients that watch them.
    const create = await api(h, '/v1/runs', { method: 'POST', json: { agentStrategy: 'direct', messages: [{ role: 'user', content: 'no hooks' }] } });
    const id = (await create.json()).run.id;
    const events = (await readSse(await api(h, `/v1/runs/${id}/events`))).map((e) => JSON.parse(e).type);
    expect(events.at(-1)).toBe('run.completed');
  });
});
