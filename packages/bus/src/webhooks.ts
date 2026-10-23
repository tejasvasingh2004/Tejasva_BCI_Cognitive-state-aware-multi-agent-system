import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { RunEvent, WebhookEventType, WebhookPayload } from '@neuroflow/contracts';
import { runsRepo, webhooksRepo, type Pool } from '@neuroflow/db';

/** Seals secrets at rest (SECRETS_KEY); `SecretBox` from `@neuroflow/code` satisfies it. */
export interface Sealer {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

// ---------------------------------------------------------------------------------------------
// Signing (Standard Webhooks)

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/** `v1,<base64 HMAC-SHA256("<id>.<timestamp>.<body>")>` with the secret's base64 key. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** Verifies a delivery the way receivers do (used by tests and the SDKs' reference behaviour). */
export function verifyWebhook(secret: string, headers: { id: string; timestamp: string; signature: string }, body: string, toleranceS = 300, now = Date.now()): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceS) return false;
  const expected = Buffer.from(signWebhook(secret, headers.id, ts, body));
  return headers.signature.split(' ').some((sig) => {
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ---------------------------------------------------------------------------------------------
// Destination safety (SSRF)

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const s = address.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
  }
  return false;
}

export type WebhookUrlPolicy = {
  /** Allow http and private/loopback destinations (local development and tests only). */
  allowPrivate?: boolean;
};

/** Checks a destination when it is saved: https, no credentials, not an internal address. */
export function webhookUrlProblem(raw: string, policy: WebhookUrlPolicy = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a valid URL';
  }
  if (url.username || url.password) return 'Webhook URLs must not contain credentials';
  if (policy.allowPrivate) return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'Webhook URLs must use http(s)';
  if (url.protocol !== 'https:') return 'Webhook URLs must use https';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || (isIP(host) && isPrivateAddress(host))) {
    return 'Webhook URLs must point to a public address';
  }
  return null;
}

/**
 * A connection pool that refuses private addresses at connect time, after DNS resolution, so a
 * hostname cannot be re-pointed at an internal service between the check and the request.
 */
function safeAgent(policy: WebhookUrlPolicy): Agent {
  return new Agent({
    connect: {
      timeout: 5_000,
      lookup: (hostname, options, callback) => {
        dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, []);
          const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
          if (!policy.allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
            return callback(Object.assign(new Error(`Refusing to deliver to a private address (${hostname})`), { code: 'EPRIVATE' }), []);
          }
          callback(null, list);
        });
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Publishing (outbox)

const RUN_TERMINAL: Record<string, WebhookEventType> = { 'run.completed': 'run.completed', 'run.failed': 'run.failed', 'run.cancelled': 'run.cancelled' };

/**
 * Turns platform events into webhook deliveries: one outbox row per subscribed endpoint, plus the
 * run's own `webhookUrl` for run events (async runs). Rows are written after the event itself is
 * persisted; workers deliver them.
 */
export class WebhookService {
  constructor(
    private readonly pool: Pool,
    private readonly sealer: Sealer,
  ) {}

  /** The workspace's signing secret, created on first use. */
  async ensureSecret(workspaceId: string): Promise<string> {
    const existing = await webhooksRepo.sealedSecrets(this.pool, workspaceId);
    if (existing) return this.sealer.open(existing.current);
    const secret = generateWebhookSecret();
    await webhooksRepo.createSecret(this.pool, workspaceId, this.sealer.seal(secret), secret.slice(-4));
    return this.sealer.open((await webhooksRepo.sealedSecrets(this.pool, workspaceId))!.current);
  }

  /** New secret; the previous one also signs for `graceMs` so receivers can switch over. */
  async rotateSecret(workspaceId: string, graceMs = 24 * 3600_000): Promise<string> {
    const secret = generateWebhookSecret();
    await webhooksRepo.rotateSecret(this.pool, workspaceId, this.sealer.seal(secret), secret.slice(-4), graceMs);
    return secret;
  }

  /** Secrets that currently sign deliveries (current first). */
  async signingSecrets(workspaceId: string): Promise<string[]> {
    const sealed = await webhooksRepo.sealedSecrets(this.pool, workspaceId);
    if (!sealed) return [];
    return [sealed.current, ...(sealed.previous ? [sealed.previous] : [])].map((s) => this.sealer.open(s));
  }

  async publish(workspaceId: string, type: WebhookEventType, data: Record<string, unknown>, opts: { runId?: string; callbackUrl?: string } = {}): Promise<string[]> {
    const payload = (id: string): WebhookPayload => ({ id, type, timestamp: new Date().toISOString(), workspaceId, data });
    const items: Parameters<typeof webhooksRepo.enqueue>[1] = (await webhooksRepo.subscribers(this.pool, workspaceId, type)).map((t) => ({
      workspaceId,
      endpointId: t.id,
      runId: opts.runId ?? null,
      url: t.url,
      eventType: type,
      payload,
    }));
    if (opts.callbackUrl) items.push({ workspaceId, endpointId: null, runId: opts.runId ?? null, url: opts.callbackUrl, eventType: type, payload });
    if (items.length === 0) return [];
    await this.ensureSecret(workspaceId);
    return webhooksRepo.enqueue(this.pool, items);
  }

  /** A test delivery to one endpoint, whatever it subscribes to. */
  async test(workspaceId: string, endpointId: string): Promise<string | null> {
    const endpoint = await webhooksRepo.get(this.pool, workspaceId, endpointId);
    if (!endpoint) return null;
    await this.ensureSecret(workspaceId);
    const [id] = await webhooksRepo.enqueue(this.pool, [
      {
        workspaceId,
        endpointId,
        runId: null,
        url: endpoint.url,
        eventType: 'webhook.test',
        payload: (pid) => ({ id: pid, type: 'webhook.test', timestamp: new Date().toISOString(), workspaceId, data: { message: 'This is a test delivery from NeuroFlow.' } }),
      },
    ]);
    return id ?? null;
  }

  /** Hook for `RunEventEmitter`: run outcomes and approval requests become webhook events. */
  async fromRunEvent(workspaceId: string, event: RunEvent): Promise<void> {
    const type = RUN_TERMINAL[event.type] ?? (event.type === 'approval.requested' ? 'run.approval_requested' : undefined);
    if (!type) return;
    const run = await runsRepo.get(this.pool, event.runId, workspaceId);
    if (!run) return;
    const callbackUrl = (run.request as { webhookUrl?: string }).webhookUrl;
    const data: Record<string, unknown> =
      type === 'run.approval_requested'
        ? { runId: run.id, conversationId: run.conversationId, ...(event.data as object) }
        : {
            run: {
              id: run.id,
              status: run.status,
              conversationId: run.conversationId,
              output: run.output,
              error: run.error,
              usage: run.usage,
              toolCalls: run.toolCalls,
              metadata: (run.request as { metadata?: unknown }).metadata ?? null,
              createdAt: run.createdAt,
              completedAt: run.completedAt,
            },
          };
    await this.publish(workspaceId, type, data, { runId: run.id, ...(callbackUrl ? { callbackUrl } : {}) });
  }
}

// ---------------------------------------------------------------------------------------------
// Delivery

/** Retry schedule after each failed attempt (about two days in total), then the delivery fails. */
export const WEBHOOK_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 3600_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000];

export type WebhookDelivererOptions = WebhookUrlPolicy & {
  intervalMs?: number;
  batchSize?: number;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  onError?: (err: unknown) => void;
};

/**
 * Sends due outbox rows: signs with the workspace's secret(s), POSTs with a timeout and no
 * redirects, records the outcome and schedules retries. 2xx = delivered; 410 Gone also turns the
 * endpoint off. Several workers can run it at once (rows are claimed with SKIP LOCKED).
 */
export class WebhookDeliverer {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private readonly agent: Agent;

  constructor(
    private readonly pool: Pool,
    private readonly service: WebhookService,
    private readonly opts: WebhookDelivererOptions = {},
  ) {
    this.agent = safeAgent(opts);
  }

  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      await this.tick().catch((err) => this.opts.onError?.(err));
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.intervalMs ?? 1_000);
    };
    void loop();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.agent.close().catch(() => {});
  }

  /** One pass over due deliveries; returns how many were attempted. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const timeoutMs = this.opts.timeoutMs ?? 10_000;
      const batch = await webhooksRepo.claim(this.pool, this.opts.batchSize ?? 20, timeoutMs + 30_000);
      await Promise.all(batch.map((d) => this.deliver(d)));
      return batch.length;
    } finally {
      this.running = false;
    }
  }

  private async deliver(d: Awaited<ReturnType<typeof webhooksRepo.claim>>[number]): Promise<void> {
    const delays = this.opts.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
    const retryInMs = d.attempts <= delays.length ? delays[d.attempts - 1]! : null;
    const problem = webhookUrlProblem(d.url, this.opts);
    if (problem) return webhooksRepo.markFailed(this.pool, d.id, { statusCode: null, error: problem, retryInMs: null });

    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    // Read per delivery (one indexed row, no cache) so a rotated secret signs at once.
    const secrets = await this.service.signingSecrets(d.workspaceId);
    const signature = secrets.map((s) => signWebhook(s, d.id, timestamp, body)).join(' ');
    try {
      const res = await undiciFetch(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'NeuroFlow-Webhooks/1',
          'webhook-id': d.id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signature,
        },
        body,
        redirect: 'manual',
        dispatcher: this.agent,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return webhooksRepo.markDelivered(this.pool, d.id, res.status);
      if (res.status === 410 && d.endpointId) {
        await webhooksRepo.disable(this.pool, d.endpointId, 'The endpoint answered 410 Gone');
        return webhooksRepo.markFailed(this.pool, d.id, { statusCode: 410, error: 'Gone: endpoint disabled', retryInMs: null });
      }
      const why = res.status >= 300 && res.status < 400 ? `Redirects are not followed (HTTP ${res.status})` : `HTTP ${res.status}`;
      return webhooksRepo.markFailed(this.pool, d.id, { statusCode: res.status, error: why, retryInMs });
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      const message =
        e.name === 'TimeoutError' ? 'Timed out' : e.cause?.code === 'EPRIVATE' ? (e.cause.message ?? 'Private address refused') : (e.cause?.message ?? e.message ?? 'Request failed');
      return webhooksRepo.markFailed(this.pool, d.id, { statusCode: null, error: message, retryInMs: e.cause?.code === 'EPRIVATE' ? null : retryInMs });
    }
  }
}
