import { randomUUID } from 'node:crypto';
import type { CreateWebhookBody, UpdateWebhookBody, WebhookDelivery, WebhookEndpoint, WebhookEventType } from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

const toEndpoint = (r: Record<string, unknown>): WebhookEndpoint => ({
  id: r.id as string,
  url: r.url as string,
  description: (r.description as string | null) ?? null,
  eventTypes: (r.event_types as WebhookEventType[]) ?? [],
  enabled: r.enabled as boolean,
  disabledReason: (r.disabled_reason as string | null) ?? null,
  createdAt: iso(r.created_at as Date)!,
  lastDelivery: r.last_status
    ? { status: r.last_status as WebhookDelivery['status'], statusCode: (r.last_code as number | null) ?? null, at: iso(r.last_at as Date)! }
    : null,
});

const toDelivery = (r: Record<string, unknown>): WebhookDelivery => ({
  id: r.id as string,
  endpointId: (r.endpoint_id as string | null) ?? null,
  url: r.url as string,
  eventType: r.event_type as string,
  runId: (r.run_id as string | null) ?? null,
  status: r.status as WebhookDelivery['status'],
  attempts: r.attempts as number,
  nextAttemptAt: r.status === 'pending' ? iso(r.next_attempt_at as Date) : null,
  lastStatusCode: (r.last_status_code as number | null) ?? null,
  lastError: (r.last_error as string | null) ?? null,
  deliveredAt: iso(r.delivered_at as Date | null),
  createdAt: iso(r.created_at as Date)!,
});

const ENDPOINT_SELECT = `SELECT e.*, d.status AS last_status, d.last_status_code AS last_code, COALESCE(d.delivered_at, d.created_at) AS last_at
  FROM webhook_endpoints e
  LEFT JOIN LATERAL (SELECT status, last_status_code, delivered_at, created_at FROM webhook_deliveries
                      WHERE endpoint_id = e.id ORDER BY created_at DESC LIMIT 1) d ON true`;

export type ClaimedDelivery = {
  id: string;
  workspaceId: string;
  endpointId: string | null;
  url: string;
  eventType: string;
  payload: unknown;
  attempts: number;
};

export type SealedSecrets = { current: string; previous: string | null };

/** Webhook endpoints, signing secrets (sealed by the caller) and the delivery outbox. */
export const webhooksRepo = {
  // ---- signing secret (one per workspace) ----
  async secretInfo(db: Queryable, workspaceId: string): Promise<{ hint: string; createdAt: string } | null> {
    const { rows } = await db.query('SELECT hint, created_at FROM webhook_secrets WHERE workspace_id = $1', [workspaceId]);
    return rows[0] ? { hint: rows[0].hint as string, createdAt: iso(rows[0].created_at as Date)! } : null;
  },

  /** Stores a sealed secret unless the workspace already has one (race-safe). */
  async createSecret(db: Queryable, workspaceId: string, sealed: string, hint: string): Promise<void> {
    await db.query('INSERT INTO webhook_secrets (workspace_id, secret_ciphertext, hint) VALUES ($1, $2, $3) ON CONFLICT (workspace_id) DO NOTHING', [
      workspaceId,
      sealed,
      hint,
    ]);
  },

  /** Replaces the secret; the previous one keeps signing until `graceMs` from now. */
  async rotateSecret(db: Queryable, workspaceId: string, sealed: string, hint: string, graceMs: number): Promise<void> {
    await db.query(
      `INSERT INTO webhook_secrets (workspace_id, secret_ciphertext, hint) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE
         SET previous_ciphertext = webhook_secrets.secret_ciphertext,
             previous_expires_at = now() + ($4::int * interval '1 millisecond'),
             secret_ciphertext = EXCLUDED.secret_ciphertext, hint = EXCLUDED.hint, created_at = now()`,
      [workspaceId, sealed, hint, graceMs],
    );
  },

  /** Sealed secrets that currently sign (the previous one only within its grace period). */
  async sealedSecrets(db: Queryable, workspaceId: string): Promise<SealedSecrets | null> {
    const { rows } = await db.query(
      `SELECT secret_ciphertext, CASE WHEN previous_expires_at > now() THEN previous_ciphertext END AS previous
         FROM webhook_secrets WHERE workspace_id = $1`,
      [workspaceId],
    );
    return rows[0] ? { current: rows[0].secret_ciphertext as string, previous: (rows[0].previous as string | null) ?? null } : null;
  },

  // ---- endpoints ----
  async list(db: Queryable, workspaceId: string): Promise<WebhookEndpoint[]> {
    const { rows } = await db.query(`${ENDPOINT_SELECT} WHERE e.workspace_id = $1 ORDER BY e.created_at`, [workspaceId]);
    return rows.map(toEndpoint);
  },

  async get(db: Queryable, workspaceId: string, id: string): Promise<WebhookEndpoint | null> {
    const { rows } = await db.query(`${ENDPOINT_SELECT} WHERE e.workspace_id = $1 AND e.id = $2`, [workspaceId, id]);
    return rows[0] ? toEndpoint(rows[0]) : null;
  },

  async create(db: Queryable, workspaceId: string, body: CreateWebhookBody, userId: string | null): Promise<WebhookEndpoint> {
    const { rows } = await db.query(
      'INSERT INTO webhook_endpoints (workspace_id, url, description, event_types, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [workspaceId, body.url, body.description ?? null, body.eventTypes, userId],
    );
    return (await webhooksRepo.get(db, workspaceId, rows[0].id as string))!;
  },

  async update(db: Queryable, workspaceId: string, id: string, patch: UpdateWebhookBody): Promise<WebhookEndpoint | null> {
    const { rowCount } = await db.query(
      `UPDATE webhook_endpoints
          SET url = COALESCE($3, url),
              description = CASE WHEN $4::boolean THEN $5 ELSE description END,
              event_types = COALESCE($6, event_types),
              enabled = COALESCE($7, enabled),
              disabled_reason = CASE WHEN $7 IS TRUE THEN NULL ELSE disabled_reason END,
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id, patch.url ?? null, patch.description !== undefined, patch.description ?? null, patch.eventTypes ?? null, patch.enabled ?? null],
    );
    return rowCount ? webhooksRepo.get(db, workspaceId, id) : null;
  },

  async delete(db: Queryable, workspaceId: string, id: string): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM webhook_endpoints WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
    return (rowCount ?? 0) > 0;
  },

  /** Turns an endpoint off (it answered 410 Gone). */
  async disable(db: Queryable, id: string, reason: string): Promise<void> {
    await db.query('UPDATE webhook_endpoints SET enabled = false, disabled_reason = $2, updated_at = now() WHERE id = $1', [id, reason]);
  },

  /** Enabled endpoints of a workspace subscribed to an event type (empty subscription = all). */
  async subscribers(db: Queryable, workspaceId: string, eventType: string): Promise<{ id: string; url: string }[]> {
    const { rows } = await db.query(
      `SELECT id, url FROM webhook_endpoints
        WHERE workspace_id = $1 AND enabled AND (cardinality(event_types) = 0 OR $2 = ANY(event_types))`,
      [workspaceId, eventType],
    );
    return rows.map((r) => ({ id: r.id as string, url: r.url as string }));
  },

  // ---- outbox ----
  async enqueue(
    db: Queryable,
    items: { workspaceId: string; endpointId: string | null; runId: string | null; url: string; eventType: string; payload: (id: string) => unknown }[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const item of items) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO webhook_deliveries (id, workspace_id, endpoint_id, run_id, url, event_type, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, item.workspaceId, item.endpointId, item.runId, item.url, item.eventType, JSON.stringify(item.payload(id))],
      );
      ids.push(id);
    }
    return ids;
  },

  /**
   * Claims due deliveries for this worker (other workers skip locked rows). A claim is a lease:
   * if the worker dies mid-delivery the row becomes due again when the lease expires.
   */
  async claim(db: Queryable, limit: number, leaseMs: number): Promise<ClaimedDelivery[]> {
    const { rows } = await db.query(
      `UPDATE webhook_deliveries d
          SET status = 'delivering', attempts = d.attempts + 1, lease_until = now() + ($2::int * interval '1 millisecond')
        WHERE d.id IN (
          SELECT id FROM webhook_deliveries
           WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'delivering' AND lease_until < now())
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.workspace_id, d.endpoint_id, d.url, d.event_type, d.payload, d.attempts`,
      [limit, leaseMs],
    );
    return rows.map((r) => ({
      id: r.id as string,
      workspaceId: r.workspace_id as string,
      endpointId: (r.endpoint_id as string | null) ?? null,
      url: r.url as string,
      eventType: r.event_type as string,
      payload: r.payload,
      attempts: r.attempts as number,
    }));
  },

  async markDelivered(db: Queryable, id: string, statusCode: number): Promise<void> {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), last_status_code = $2, last_error = NULL, lease_until = NULL WHERE id = $1`,
      [id, statusCode],
    );
  },

  /** A failed attempt: retry at `retryInMs`, or give up when null. */
  async markFailed(db: Queryable, id: string, result: { statusCode: number | null; error: string; retryInMs: number | null }): Promise<void> {
    await db.query(
      `UPDATE webhook_deliveries
          SET status = CASE WHEN $4::int IS NULL THEN 'failed' ELSE 'pending' END,
              next_attempt_at = CASE WHEN $4::int IS NULL THEN next_attempt_at ELSE now() + ($4::int * interval '1 millisecond') END,
              last_status_code = $2, last_error = $3, lease_until = NULL
        WHERE id = $1`,
      [id, result.statusCode, result.error.slice(0, 300), result.retryInMs],
    );
  },

  async deliveries(db: Queryable, workspaceId: string, opts: { endpointId?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
    const { rows } = await db.query(
      `SELECT * FROM webhook_deliveries WHERE workspace_id = $1 AND ($2::uuid IS NULL OR endpoint_id = $2)
        ORDER BY created_at DESC LIMIT $3`,
      [workspaceId, opts.endpointId ?? null, Math.min(opts.limit ?? 25, 100)],
    );
    return rows.map(toDelivery);
  },

  /** Sends a finished (delivered or failed) delivery again, with the same id and payload. */
  async retry(db: Queryable, workspaceId: string, id: string): Promise<WebhookDelivery | null> {
    const { rows } = await db.query(
      `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now(), lease_until = NULL
        WHERE workspace_id = $1 AND id = $2 AND status IN ('delivered', 'failed') RETURNING *`,
      [workspaceId, id],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  },
};
