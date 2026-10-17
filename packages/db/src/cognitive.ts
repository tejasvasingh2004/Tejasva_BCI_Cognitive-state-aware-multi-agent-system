import type { CognitiveState } from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

export const cognitiveRepo = {
  async get(db: Queryable, workspaceId: string, userId: string): Promise<(CognitiveState & { provider: string }) | null> {
    const { rows } = await db.query(
      'SELECT * FROM cognitive_sessions WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      workload: r.workload,
      confidence: r.confidence,
      source: r.source,
      observedAt: iso(r.observed_at)!,
      provider: r.provider,
    };
  },

  async upsert(
    db: Queryable,
    workspaceId: string,
    userId: string,
    provider: string,
    state: CognitiveState,
  ): Promise<void> {
    await db.query(
      `INSERT INTO cognitive_sessions (workspace_id, user_id, provider, workload, confidence, source, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         provider = EXCLUDED.provider, workload = EXCLUDED.workload, confidence = EXCLUDED.confidence,
         source = EXCLUDED.source, observed_at = EXCLUDED.observed_at, updated_at = now()`,
      [workspaceId, userId, provider, state.workload, state.confidence, state.source, state.observedAt],
    );
  },
};
