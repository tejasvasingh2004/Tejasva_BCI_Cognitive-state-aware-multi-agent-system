import { createHash, randomBytes } from 'node:crypto';
import type { Me } from '@neuroflow/contracts';
import type { Queryable } from './client';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string } {
  const key = `nf_${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10) };
}

export type ApiKeyRecord = { id: string; workspaceId: string; userId: string; scopes: string[] };

export const authRepo = {
  async findActiveApiKey(db: Queryable, key: string): Promise<ApiKeyRecord | null> {
    const { rows } = await db.query(
      `UPDATE api_keys SET last_used_at = now()
        WHERE key_hash = $1 AND revoked_at IS NULL
        RETURNING id, workspace_id, user_id, scopes`,
      [hashApiKey(key)],
    );
    const r = rows[0];
    return r ? { id: r.id, workspaceId: r.workspace_id, userId: r.user_id, scopes: r.scopes } : null;
  },

  async createApiKey(
    db: Queryable,
    input: { workspaceId: string; userId: string; name: string; scopes: string[]; key?: string },
  ): Promise<{ id: string; key: string; prefix: string }> {
    const generated = input.key ? { key: input.key, prefix: input.key.slice(0, 10) } : generateApiKey();
    const { rows } = await db.query(
      `INSERT INTO api_keys (workspace_id, user_id, name, prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key_hash) DO UPDATE SET revoked_at = NULL, scopes = EXCLUDED.scopes
       RETURNING id`,
      [input.workspaceId, input.userId, input.name, generated.prefix, hashApiKey(generated.key), input.scopes],
    );
    return { id: rows[0].id, ...generated };
  },

  async revokeApiKey(db: Queryable, workspaceId: string, id: string): Promise<boolean> {
    const res = await db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL',
      [id, workspaceId],
    );
    return (res.rowCount ?? 0) > 0;
  },

  async membershipRole(db: Queryable, userId: string, workspaceId: string): Promise<string | null> {
    const { rows } = await db.query(
      'SELECT role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2',
      [userId, workspaceId],
    );
    return rows[0]?.role ?? null;
  },

  async me(db: Queryable, userId: string, workspaceId: string, scopes: string[]): Promise<Me | null> {
    const { rows } = await db.query(
      `SELECT u.id AS user_id, u.email, u.display_name, w.id AS workspace_id, w.name AS workspace_name
         FROM users u
         JOIN workspace_members m ON m.user_id = u.id
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE u.id = $1 AND w.id = $2`,
      [userId, workspaceId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      user: { id: r.user_id, email: r.email, displayName: r.display_name },
      workspace: { id: r.workspace_id, name: r.workspace_name },
      scopes,
    };
  },

  /** Idempotently creates a user with a personal workspace (used for dev login and seeding). */
  async ensureUserWithWorkspace(
    db: Queryable,
    input: { email: string; displayName: string; workspaceName: string },
  ): Promise<{ userId: string; workspaceId: string }> {
    const user = await db.query(
      `INSERT INTO users (email, display_name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [input.email.toLowerCase(), input.displayName],
    );
    const userId: string = user.rows[0].id;
    const existing = await db.query(
      `SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = $1 AND m.role = 'owner' ORDER BY w.created_at LIMIT 1`,
      [userId],
    );
    if (existing.rows[0]) return { userId, workspaceId: existing.rows[0].id };
    const ws = await db.query('INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id', [
      input.workspaceName,
      userId,
    ]);
    const workspaceId: string = ws.rows[0].id;
    await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      workspaceId,
      userId,
    ]);
    return { userId, workspaceId };
  },
};
