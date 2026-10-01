import type { AuditAction, AuditEvent } from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

export type AuditInput = {
  action: AuditAction;
  outcome?: 'success' | 'failure';
  workspaceId?: string | null;
  actorUserId?: string | null;
  actorVia?: string | null;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  /** Small, non-sensitive context. Never secrets, credentials or message content. */
  metadata?: Record<string, unknown>;
};

const toEvent = (r: Record<string, unknown>): AuditEvent => ({
  id: r.id as string,
  workspaceId: (r.workspace_id as string | null) ?? null,
  actorUserId: (r.actor_user_id as string | null) ?? null,
  actorVia: (r.actor_via as string | null) ?? null,
  action: r.action as AuditAction,
  targetType: (r.target_type as string | null) ?? null,
  targetId: (r.target_id as string | null) ?? null,
  outcome: r.outcome as AuditEvent['outcome'],
  ip: (r.ip as string | null) ?? null,
  metadata: (r.metadata as Record<string, unknown>) ?? {},
  createdAt: iso(r.created_at as Date)!,
});

/** Append-only audit trail of security-relevant actions. */
export const auditRepo = {
  async record(db: Queryable, e: AuditInput): Promise<void> {
    await db.query(
      `INSERT INTO audit_events (workspace_id, actor_user_id, actor_via, action, target_type, target_id, outcome, ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.workspaceId ?? null,
        e.actorUserId ?? null,
        e.actorVia ?? null,
        e.action,
        e.targetType ?? null,
        e.targetId ?? null,
        e.outcome ?? 'success',
        e.ip ?? null,
        JSON.stringify(e.metadata ?? {}),
      ],
    );
  },

  async list(
    db: Queryable,
    workspaceId: string,
    opts: { limit?: number; before?: string; action?: string } = {},
  ): Promise<AuditEvent[]> {
    const { rows } = await db.query(
      `SELECT * FROM audit_events
        WHERE workspace_id = $1
          AND ($2::timestamptz IS NULL OR created_at < $2)
          AND ($3::text IS NULL OR action = $3)
        ORDER BY created_at DESC LIMIT $4`,
      [workspaceId, opts.before ?? null, opts.action ?? null, Math.min(opts.limit ?? 50, 200)],
    );
    return rows.map(toEvent);
  },
};
