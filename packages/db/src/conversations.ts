import type { ChatMessage, Conversation, StoredMessage } from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

const toConversation = (r: Record<string, unknown>): Conversation => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  title: r.title as string,
  createdAt: iso(r.created_at as Date)!,
  updatedAt: iso(r.updated_at as Date)!,
});

const toMessage = (r: Record<string, unknown>): StoredMessage => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  runId: (r.run_id as string | null) ?? null,
  role: r.role as StoredMessage['role'],
  content: r.content as string,
  ...(r.name ? { name: r.name as string } : {}),
  ...(r.tool_calls ? { toolCalls: r.tool_calls as StoredMessage['toolCalls'] } : {}),
  ...(r.tool_call_id ? { toolCallId: r.tool_call_id as string } : {}),
  createdAt: iso(r.created_at as Date)!,
});

export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean || 'New conversation';
  const cut = clean.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60)}…`;
}

export const conversationsRepo = {
  async create(db: Queryable, input: { workspaceId: string; userId: string; title?: string }): Promise<Conversation> {
    const { rows } = await db.query(
      `INSERT INTO conversations (workspace_id, created_by, title) VALUES ($1, $2, COALESCE($3, 'New conversation'))
       RETURNING *`,
      [input.workspaceId, input.userId, input.title ?? null],
    );
    return toConversation(rows[0]);
  },

  async get(db: Queryable, workspaceId: string, id: string): Promise<Conversation | null> {
    const { rows } = await db.query(
      'SELECT * FROM conversations WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL',
      [id, workspaceId],
    );
    return rows[0] ? toConversation(rows[0]) : null;
  },

  async list(db: Queryable, workspaceId: string, limit = 50): Promise<Conversation[]> {
    const { rows } = await db.query(
      `SELECT * FROM conversations WHERE workspace_id = $1 AND archived_at IS NULL
        ORDER BY updated_at DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return rows.map(toConversation);
  },

  async rename(db: Queryable, workspaceId: string, id: string, title: string): Promise<Conversation | null> {
    const { rows } = await db.query(
      `UPDATE conversations SET title = $3, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL RETURNING *`,
      [id, workspaceId, title],
    );
    return rows[0] ? toConversation(rows[0]) : null;
  },

  /** Sets the title only if it is still the default (first message becomes the title). */
  async titleIfDefault(db: Queryable, id: string, title: string): Promise<void> {
    await db.query(
      `UPDATE conversations SET title = $2 WHERE id = $1 AND title = 'New conversation'`,
      [id, title],
    );
  },

  async archive(db: Queryable, workspaceId: string, id: string): Promise<boolean> {
    const res = await db.query(
      'UPDATE conversations SET archived_at = now() WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL',
      [id, workspaceId],
    );
    return (res.rowCount ?? 0) > 0;
  },

  async touch(db: Queryable, id: string): Promise<void> {
    await db.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [id]);
  },
};

export const messagesRepo = {
  async append(
    db: Queryable,
    conversationId: string,
    messages: ChatMessage[],
    runId: string | null = null,
  ): Promise<StoredMessage[]> {
    const out: StoredMessage[] = [];
    for (const m of messages) {
      const { rows } = await db.query(
        `INSERT INTO messages (conversation_id, run_id, role, content, name, tool_calls, tool_call_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          conversationId,
          runId,
          m.role,
          m.content,
          m.name ?? null,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.toolCallId ?? null,
        ],
      );
      out.push(toMessage(rows[0]));
    }
    return out;
  },

  async listByConversation(db: Queryable, conversationId: string, limit = 500): Promise<StoredMessage[]> {
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT * FROM messages WHERE conversation_id = $1 ORDER BY position DESC LIMIT $2
       ) m ORDER BY position ASC`,
      [conversationId, limit],
    );
    return rows.map(toMessage);
  },

  async linkToRun(db: Queryable, messageIds: string[], runId: string): Promise<void> {
    if (messageIds.length === 0) return;
    await db.query('UPDATE messages SET run_id = $2 WHERE id = ANY($1::uuid[])', [messageIds, runId]);
  },
};
