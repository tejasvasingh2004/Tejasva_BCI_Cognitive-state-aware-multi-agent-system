import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ApiKeyInfo, Me, WorkspaceRole } from '@neuroflow/contracts';
import type { Queryable } from './client';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string } {
  const key = `nf_${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10) };
}

export type ApiKeyRecord = { id: string; workspaceId: string; userId: string; scopes: string[]; role: WorkspaceRole };

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64, maxmem: 64 * 1024 * 1024 };

/** scrypt password hash in a self-describing format: `scrypt$N$r$p$salt$hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Verified against when the email is unknown, so response time does not reveal which accounts exist.
let dummyHash: Promise<string> | undefined;

const toApiKeyInfo = (r: Record<string, unknown>): ApiKeyInfo => ({
  id: r.id as string,
  name: r.name as string,
  prefix: r.prefix as string,
  scopes: r.scopes as string[],
  createdAt: (r.created_at as Date).toISOString(),
  lastUsedAt: r.last_used_at ? (r.last_used_at as Date).toISOString() : null,
  revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
});

export const authRepo = {
  /**
   * Resolves an active key. The key's owner must still be a member of the key's workspace: removing
   * a member immediately invalidates their keys.
   */
  async findActiveApiKey(db: Queryable, key: string): Promise<ApiKeyRecord | null> {
    const { rows } = await db.query(
      `UPDATE api_keys k SET last_used_at = now()
         FROM workspace_members m
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL
          AND m.workspace_id = k.workspace_id AND m.user_id = k.user_id
        RETURNING k.id, k.workspace_id, k.user_id, k.scopes, m.role`,
      [hashApiKey(key)],
    );
    const r = rows[0];
    return r ? { id: r.id, workspaceId: r.workspace_id, userId: r.user_id, scopes: r.scopes, role: r.role } : null;
  },

  async listApiKeys(db: Queryable, workspaceId: string, userId: string): Promise<ApiKeyInfo[]> {
    const { rows } = await db.query(
      'SELECT * FROM api_keys WHERE workspace_id = $1 AND user_id = $2 ORDER BY created_at DESC',
      [workspaceId, userId],
    );
    return rows.map(toApiKeyInfo);
  },

  async getApiKeyInfo(db: Queryable, id: string): Promise<ApiKeyInfo | null> {
    const { rows } = await db.query('SELECT * FROM api_keys WHERE id = $1', [id]);
    return rows[0] ? toApiKeyInfo(rows[0]) : null;
  },

  /** Verifies email + password. Returns the user's primary workspace, or null on any failure. */
  async verifyLogin(db: Queryable, email: string, password: string): Promise<{ userId: string; workspaceId: string } | null> {
    const { rows } = await db.query(
      `SELECT u.id, u.password_hash, m.workspace_id
         FROM users u
         LEFT JOIN LATERAL (
           SELECT workspace_id FROM workspace_members WHERE user_id = u.id
            ORDER BY (role = 'owner') DESC, created_at LIMIT 1
         ) m ON true
        WHERE u.email = $1`,
      [email.toLowerCase()],
    );
    const r = rows[0];
    if (!r?.password_hash) {
      dummyHash ??= hashPassword(randomBytes(12).toString('hex'));
      await verifyPassword(password, await dummyHash);
      return null;
    }
    if (!(await verifyPassword(password, r.password_hash))) return null;
    return r.workspace_id ? { userId: r.id, workspaceId: r.workspace_id } : null;
  },

  async setPassword(db: Queryable, userId: string, password: string): Promise<void> {
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword(password)]);
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

  /** Revokes a key. Without `userId` (admins), any key in the workspace may be revoked. */
  async revokeApiKey(db: Queryable, workspaceId: string, id: string, userId?: string): Promise<boolean> {
    const res = await db.query(
      `UPDATE api_keys SET revoked_at = now()
        WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL AND ($3::uuid IS NULL OR user_id = $3)`,
      [id, workspaceId, userId ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  },

  async membershipRole(db: Queryable, userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const { rows } = await db.query(
      'SELECT role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2',
      [userId, workspaceId],
    );
    return rows[0]?.role ?? null;
  },

  async me(db: Queryable, userId: string, workspaceId: string, scopes: string[]): Promise<Me | null> {
    const { rows } = await db.query(
      `SELECT u.id AS user_id, u.email, u.display_name, w.id AS workspace_id, w.name AS workspace_name, m.role
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
      role: r.role,
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
