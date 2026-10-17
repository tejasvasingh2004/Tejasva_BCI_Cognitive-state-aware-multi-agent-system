import { Plan, type WorkspaceSettings } from '@neuroflow/contracts';
import type { Queryable } from './client';

export const workspaceRepo = {
  async getPlan(db: Queryable, workspaceId: string): Promise<Plan | null> {
    const { rows } = await db.query('SELECT plan FROM workspaces WHERE id = $1', [workspaceId]);
    return rows[0] ? Plan.parse(rows[0].plan) : null;
  },

  async setPlan(db: Queryable, workspaceId: string, plan: Plan): Promise<boolean> {
    const { rowCount } = await db.query('UPDATE workspaces SET plan = $2 WHERE id = $1', [workspaceId, Plan.parse(plan)]);
    return (rowCount ?? 0) > 0;
  },

  async getSettings(db: Queryable, workspaceId: string): Promise<WorkspaceSettings | null> {
    const { rows } = await db.query('SELECT instructions, memory_retention_days FROM workspaces WHERE id = $1', [
      workspaceId,
    ]);
    const r = rows[0];
    return r ? { instructions: r.instructions ?? '', memoryRetentionDays: r.memory_retention_days ?? null } : null;
  },

  async updateSettings(db: Queryable, workspaceId: string, patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings | null> {
    const { rows } = await db.query(
      `UPDATE workspaces SET
         instructions = CASE WHEN $2::boolean THEN $3 ELSE instructions END,
         memory_retention_days = CASE WHEN $4::boolean THEN $5::int ELSE memory_retention_days END
       WHERE id = $1
       RETURNING instructions, memory_retention_days`,
      [
        workspaceId,
        patch.instructions !== undefined,
        patch.instructions ?? '',
        patch.memoryRetentionDays !== undefined,
        patch.memoryRetentionDays ?? null,
      ],
    );
    const r = rows[0];
    return r ? { instructions: r.instructions, memoryRetentionDays: r.memory_retention_days ?? null } : null;
  },
};
