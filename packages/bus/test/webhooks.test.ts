import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authRepo, webhooksRepo } from '@neuroflow/db';
import { createTestDatabase, isPostgresReachable } from '@neuroflow/db/testing';
import { isPrivateAddress, signWebhook, verifyWebhook, WebhookDeliverer, webhookUrlProblem, WebhookService, type Sealer } from '../src';

describe('webhook signing and destination checks', () => {
  it('signs exactly like the Standard Webhooks reference', () => {
    // Test vector from the Standard Webhooks specification.
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const sig = signWebhook(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}');
    expect(sig).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    const headers = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature: `v1,old ${sig}` };
    expect(verifyWebhook(secret, headers, '{"test": 2432232314}', 300, 1614265330_000)).toBe(true);
    expect(verifyWebhook(secret, headers, '{"test": 1}', 300, 1614265330_000)).toBe(false);
    // Outside the tolerance window a valid signature is still refused (replay protection).
    expect(verifyWebhook(secret, headers, '{"test": 2432232314}', 300, 1614265330_000 + 600_000)).toBe(false);
  });

  it('classifies internal addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(a), a).toBe(false);
  });

  it('accepts only public https destinations unless private ones are allowed', () => {
    expect(webhookUrlProblem('https://hooks.example.com/neuroflow')).toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/x')).toMatch(/https/);
    expect(webhookUrlProblem('https://user:pw@hooks.example.com/x')).toMatch(/credentials/);
    expect(webhookUrlProblem('https://localhost/x')).toMatch(/public/);
    expect(webhookUrlProblem('https://169.254.169.254/latest/meta-data')).toMatch(/public/);
    expect(webhookUrlProblem('https://[::1]/x')).toMatch(/public/);
    expect(webhookUrlProblem('http://127.0.0.1:9000/x', { allowPrivate: true })).toBeNull();
  });
});

const reachable = await isPostgresReachable();
const sealer: Sealer = { seal: (s) => `sealed:${Buffer.from(s).toString('base64')}`, open: (s) => Buffer.from(s.slice(7), 'base64').toString() };

describe.skipIf(!reachable)('webhook outbox and delivery (Postgres)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server;
  let url: string;
  let ws: string;
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];
  let respond: (n: number) => number = () => 200;

  beforeAll(async () => {
    db = await createTestDatabase();
    ws = (await authRepo.ensureUserWithWorkspace(db.pool, { email: 'wh@example.test', displayName: 'W', workspaceName: 'W' })).workspaceId;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(respond(received.length)).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    server.close();
    await db?.drop();
  });
  beforeEach(async () => {
    received.length = 0;
    respond = () => 200;
    await db.pool.query('DELETE FROM webhook_deliveries');
    await db.pool.query('DELETE FROM webhook_endpoints');
  });

  it('delivers a signed event to subscribed endpoints only, verifiable with the workspace secret', async () => {
    const service = new WebhookService(db.pool, sealer);
    await webhooksRepo.create(db.pool, ws, { url, eventTypes: ['budget.exceeded'] }, null);
    await webhooksRepo.create(db.pool, ws, { url: `${url}?all`, eventTypes: [] }, null);
    await webhooksRepo.create(db.pool, ws, { url: `${url}?runs`, eventTypes: ['run.completed'] }, null);
    expect(await service.publish(ws, 'budget.exceeded', { scope: 'workspace_month', limitUsd: 5 })).toHaveLength(2);

    const deliverer = new WebhookDeliverer(db.pool, service, { allowPrivate: true });
    expect(await deliverer.tick()).toBe(2);
    expect(received).toHaveLength(2);
    const secret = await service.ensureSecret(ws);
    for (const r of received) {
      const headers = { id: String(r.headers['webhook-id']), timestamp: String(r.headers['webhook-timestamp']), signature: String(r.headers['webhook-signature']) };
      expect(verifyWebhook(secret, headers, r.body)).toBe(true);
      expect(JSON.parse(r.body)).toMatchObject({ id: headers.id, type: 'budget.exceeded', workspaceId: ws, data: { limitUsd: 5 } });
    }
    const log = await webhooksRepo.deliveries(db.pool, ws);
    expect(log.map((d) => [d.status, d.attempts, d.lastStatusCode])).toEqual([
      ['delivered', 1, 200],
      ['delivered', 1, 200],
    ]);
    await deliverer.stop();
  });

  it('retries failures with backoff, keeps the delivery id, and gives up after the last attempt', async () => {
    const service = new WebhookService(db.pool, sealer);
    await webhooksRepo.create(db.pool, ws, { url, eventTypes: [] }, null);
    await service.publish(ws, 'budget.threshold_reached', { limitUsd: 5 });
    respond = (n) => (n < 3 ? 503 : 200);
    // Zero delays make each retry due immediately.
    const deliverer = new WebhookDeliverer(db.pool, service, { allowPrivate: true, retryDelaysMs: [0, 0, 0] });
    await deliverer.tick();
    let [d] = await webhooksRepo.deliveries(db.pool, ws);
    expect(d).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 503, lastError: 'HTTP 503' });
    await deliverer.tick();
    await deliverer.tick();
    [d] = await webhooksRepo.deliveries(db.pool, ws);
    expect(d).toMatchObject({ status: 'delivered', attempts: 3, lastStatusCode: 200 });
    expect(new Set(received.map((r) => r.headers['webhook-id'])).size).toBe(1);

    respond = () => 500;
    await service.publish(ws, 'budget.exceeded', {});
    const short = new WebhookDeliverer(db.pool, service, { allowPrivate: true, retryDelaysMs: [0] });
    await short.tick();
    await short.tick();
    const failed = (await webhooksRepo.deliveries(db.pool, ws)).find((x) => x.eventType === 'budget.exceeded');
    expect(failed).toMatchObject({ status: 'failed', attempts: 2 });
    // A finished delivery can be sent again on request.
    expect((await webhooksRepo.retry(db.pool, ws, failed!.id))?.status).toBe('pending');
    await Promise.all([deliverer.stop(), short.stop()]);
  });

  it('turns an endpoint off when it answers 410 Gone, and refuses private destinations at connect time', async () => {
    const service = new WebhookService(db.pool, sealer);
    const gone = await webhooksRepo.create(db.pool, ws, { url, eventTypes: [] }, null);
    respond = () => 410;
    await service.publish(ws, 'budget.exceeded', {});
    const deliverer = new WebhookDeliverer(db.pool, service, { allowPrivate: true });
    await deliverer.tick();
    expect(await webhooksRepo.get(db.pool, ws, gone.id)).toMatchObject({ enabled: false, disabledReason: 'The endpoint answered 410 Gone' });
    await deliverer.stop();

    // "localhost." passes the URL check (it is not literally "localhost") but resolves to 127.0.0.1:
    // the connection is refused after DNS resolution, and the delivery is not retried.
    await db.pool.query('DELETE FROM webhook_endpoints');
    const port = (server.address() as AddressInfo).port;
    await webhooksRepo.create(db.pool, ws, { url: `https://localhost.:${port}/hook`, eventTypes: [] }, null);
    received.length = 0;
    await service.publish(ws, 'budget.exceeded', {});
    const strict = new WebhookDeliverer(db.pool, service);
    await strict.tick();
    const [d] = await webhooksRepo.deliveries(db.pool, ws);
    expect(d).toMatchObject({ status: 'failed' });
    expect(d!.lastError).toMatch(/private address/);
    expect(received).toHaveLength(0);
    await strict.stop();
  });
});
