import type { AgentSpec } from '@neuroflow/contracts';
import type { Queryable } from './client';

const toAgent = (r: Record<string, unknown>): AgentSpec => ({
  id: r.id as string,
  name: r.name as string,
  description: r.description as string,
  instructions: r.instructions as string,
  capabilities: (r.capabilities as string[]) ?? [],
  tools: (r.tools as string[]) ?? [],
  modelRole: (r.model_role as AgentSpec['modelRole']) ?? 'agent',
  maxIterations: (r.max_iterations as number) ?? 4,
  ...(r.output_contract ? { outputContract: r.output_contract as AgentSpec['outputContract'] } : {}),
});

/** Workspace-defined agents. Built-in agents live in code (packages/orchestrator). */
export const agentsRepo = {
  async listForWorkspace(db: Queryable, workspaceId: string): Promise<AgentSpec[]> {
    const { rows } = await db.query('SELECT * FROM agents WHERE workspace_id = $1 ORDER BY name', [workspaceId]);
    return rows.map(toAgent);
  },

  async upsert(db: Queryable, workspaceId: string, a: Omit<AgentSpec, 'builtin'>): Promise<AgentSpec> {
    const { rows } = await db.query(
      `INSERT INTO agents (id, workspace_id, name, description, instructions, capabilities, tools, model_role, max_iterations, output_contract)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, instructions = EXCLUDED.instructions,
         capabilities = EXCLUDED.capabilities, tools = EXCLUDED.tools, model_role = EXCLUDED.model_role,
         max_iterations = EXCLUDED.max_iterations, output_contract = EXCLUDED.output_contract, updated_at = now()
       RETURNING *`,
      [
        a.id,
        workspaceId,
        a.name,
        a.description,
        a.instructions,
        a.capabilities,
        a.tools,
        a.modelRole,
        a.maxIterations,
        a.outputContract ? JSON.stringify(a.outputContract) : null,
      ],
    );
    return toAgent(rows[0]);
  },

  async delete(db: Queryable, workspaceId: string, id: string): Promise<boolean> {
    const res = await db.query('DELETE FROM agents WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
    return (res.rowCount ?? 0) > 0;
  },
};
