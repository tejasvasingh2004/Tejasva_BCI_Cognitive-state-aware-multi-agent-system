import type { RunEvent } from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

export const runEventsRepo = {
  async append(db: Queryable, events: RunEvent[]): Promise<void> {
    if (events.length === 0) return;
    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      values.push(e.runId, e.seq, e.type, JSON.stringify(e.data), e.ts);
      const b = i * 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
    });
    await db.query(
      `INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES ${tuples.join(', ')}
       ON CONFLICT (run_id, seq) DO NOTHING`,
      values,
    );
  },

  async list(db: Queryable, runId: string, afterSeq = 0, limit = 5000): Promise<RunEvent[]> {
    const { rows } = await db.query(
      'SELECT * FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [runId, afterSeq, limit],
    );
    return rows.map(
      (r) => ({ runId: r.run_id, seq: r.seq, type: r.type, data: r.data, ts: iso(r.created_at)! }) as RunEvent,
    );
  },

  async maxSeq(db: Queryable, runId: string): Promise<number> {
    const { rows } = await db.query('SELECT COALESCE(max(seq), 0)::int AS n FROM run_events WHERE run_id = $1', [
      runId,
    ]);
    return rows[0].n;
  },
};
