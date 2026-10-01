import type { MemoryItem } from '@neuroflow/contracts';
import { iso, type Queryable } from '@neuroflow/db';

export type MemoryScope = { workspaceId: string; userId: string };

export type MemorySearchInput = MemoryScope & { query: string; limit?: number };
export type MemoryStoreInput = MemoryScope & {
  content: string;
  tags?: string[];
  source?: 'user' | 'agent' | 'import';
  sourceRunId?: string;
  /** Explicit time-to-live; the workspace retention policy applies in addition. */
  ttlDays?: number;
};

export interface MemoryService {
  search(input: MemorySearchInput): Promise<MemoryItem[]>;
  store(input: MemoryStoreInput): Promise<MemoryItem>;
  list(scope: MemoryScope, limit?: number): Promise<MemoryItem[]>;
  delete(scope: MemoryScope, id: string): Promise<boolean>;
  /** Soft-deletes memories past their retention. Returns the number expired per workspace. */
  purgeExpired(): Promise<Array<{ workspaceId: string; count: number }>>;
}

/**
 * A memory is live until the earlier of its own `expires_at` (explicit TTL) and
 * `created_at + workspace retention`. Computing this at query time means retention changes apply
 * retroactively without rewriting rows. (LEAST ignores NULLs.)
 */
const EFFECTIVE_EXPIRY = `LEAST(m.expires_at, m.created_at + w.memory_retention_days * interval '1 day')`;
const LIVE = `m.deleted_at IS NULL AND (${EFFECTIVE_EXPIRY} IS NULL OR ${EFFECTIVE_EXPIRY} > now())`;

export const MEMORY_LIMITS = {
  maxResults: 10,
  maxItemChars: 1_000,
  maxStoreChars: 4_000,
};

const toItem = (r: Record<string, unknown>): MemoryItem => ({
  id: r.id as string,
  content: truncate(r.content as string, MEMORY_LIMITS.maxItemChars),
  tags: r.tags as string[],
  source: r.source as string,
  createdAt: iso(r.created_at as Date)!,
  expiresAt: iso((r.effective_expires_at as Date | null) ?? null),
  ...(r.score != null ? { score: Number(r.score) } : {}),
});

/**
 * PostgreSQL full-text memory store. Results are always scoped to the caller's workspace and
 * user, capped in count and size. (pgvector semantic search can replace `search` later without
 * changing callers.)
 */
export class PgMemoryService implements MemoryService {
  constructor(private readonly db: Queryable) {}

  async search({ workspaceId, userId, query, limit = 5 }: MemorySearchInput): Promise<MemoryItem[]> {
    const n = Math.min(Math.max(1, limit), MEMORY_LIMITS.maxResults);
    // OR the query lexemes so natural-language questions match partially; rank by relevance.
    const { rows } = await this.db.query(
      `WITH q AS (
         SELECT NULLIF(replace(plainto_tsquery('english', $3)::text, '&', '|'), '')::tsquery AS tsq
       )
       SELECT m.*, ts_rank_cd(m.search, q.tsq) AS score, ${EFFECTIVE_EXPIRY} AS effective_expires_at
         FROM memories m JOIN workspaces w ON w.id = m.workspace_id, q
        WHERE m.workspace_id = $1 AND m.user_id = $2 AND ${LIVE}
          AND q.tsq IS NOT NULL AND m.search @@ q.tsq
        ORDER BY score DESC, m.created_at DESC
        LIMIT $4`,
      [workspaceId, userId, query, n],
    );
    if (rows.length > 0) return rows.map(toItem);
    // Fallback for queries without indexable words (e.g. names, codes): substring match.
    const like = await this.db.query(
      `SELECT m.*, ${EFFECTIVE_EXPIRY} AS effective_expires_at
         FROM memories m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.workspace_id = $1 AND m.user_id = $2 AND ${LIVE} AND m.content ILIKE '%' || $3 || '%'
        ORDER BY m.created_at DESC LIMIT $4`,
      [workspaceId, userId, escapeLike(query.trim().slice(0, 100)), n],
    );
    return like.rows.map(toItem);
  }

  async store({ workspaceId, userId, content, tags = [], source = 'user', sourceRunId, ttlDays }: MemoryStoreInput): Promise<MemoryItem> {
    const { rows } = await this.db.query(
      `WITH m AS (
         INSERT INTO memories (workspace_id, user_id, content, tags, source, source_run_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + $7::int * interval '1 day' END)
         RETURNING *
       )
       SELECT m.*, ${EFFECTIVE_EXPIRY} AS effective_expires_at FROM m JOIN workspaces w ON w.id = m.workspace_id`,
      [
        workspaceId,
        userId,
        truncate(content.trim(), MEMORY_LIMITS.maxStoreChars),
        tags.slice(0, 10),
        source,
        sourceRunId ?? null,
        ttlDays ?? null,
      ],
    );
    return toItem(rows[0]);
  }

  async list({ workspaceId, userId }: MemoryScope, limit = 50): Promise<MemoryItem[]> {
    const { rows } = await this.db.query(
      `SELECT m.*, ${EFFECTIVE_EXPIRY} AS effective_expires_at
         FROM memories m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.workspace_id = $1 AND m.user_id = $2 AND ${LIVE}
        ORDER BY m.created_at DESC LIMIT $3`,
      [workspaceId, userId, Math.min(limit, 200)],
    );
    return rows.map(toItem);
  }

  async delete({ workspaceId, userId }: MemoryScope, id: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE memories SET deleted_at = now()
        WHERE id = $1 AND workspace_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [id, workspaceId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async purgeExpired(): Promise<Array<{ workspaceId: string; count: number }>> {
    const { rows } = await this.db.query(
      `WITH expired AS (
         UPDATE memories m SET deleted_at = now()
           FROM workspaces w
          WHERE w.id = m.workspace_id AND m.deleted_at IS NULL
            AND ${EFFECTIVE_EXPIRY} IS NOT NULL AND ${EFFECTIVE_EXPIRY} <= now()
         RETURNING m.workspace_id
       )
       SELECT workspace_id, count(*)::int AS n FROM expired GROUP BY workspace_id`,
    );
    return rows.map((r) => ({ workspaceId: r.workspace_id, count: r.n }));
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
