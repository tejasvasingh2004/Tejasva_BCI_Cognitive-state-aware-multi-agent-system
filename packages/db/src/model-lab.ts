import type {
  Dataset,
  DatasetExample,
  FineTuningJob,
  ModelDeployment,
  ModelEvaluation,
  ModelEvaluationResult,
  ModelLabConfig,
  ModelLabScope,
} from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

const toDeployment = (r: Record<string, unknown>): ModelDeployment => ({
  id: r.id as string,
  name: r.name as string,
  model: r.model as string,
  parameters: (r.parameters as ModelDeployment['parameters']) ?? {},
  description: r.description as string,
  status: r.status as ModelDeployment['status'],
  createdAt: iso(r.created_at as Date)!,
  updatedAt: iso(r.updated_at as Date)!,
});

const toExample = (r: Record<string, unknown>): DatasetExample => ({
  id: r.id as string,
  source: r.source as DatasetExample['source'],
  sourceRunId: (r.source_run_id as string | null) ?? null,
  task: r.task as string,
  context: (r.context as string | null) ?? null,
  output: r.output as string,
  expected: (r.expected as string | null) ?? null,
  outcome: (r.outcome as DatasetExample['outcome']) ?? null,
  reviewed: r.reviewed as boolean,
  createdAt: iso(r.created_at as Date)!,
});

const toEvaluation = (r: Record<string, unknown>): ModelEvaluation => ({
  id: r.id as string,
  name: r.name as string,
  datasetId: r.dataset_id as string,
  models: r.models as string[],
  scorer: r.scorer as ModelEvaluation['scorer'],
  status: r.status as ModelEvaluation['status'],
  results: (r.results as ModelEvaluationResult[]) ?? [],
  error: (r.error as string | null) ?? null,
  createdAt: iso(r.created_at as Date)!,
  completedAt: iso((r.completed_at as Date | null) ?? null),
});

const toJob = (r: Record<string, unknown>): FineTuningJob => ({
  id: r.id as string,
  name: r.name as string,
  provider: r.provider as string,
  baseModel: r.base_model as string,
  datasetId: r.dataset_id as string,
  status: r.status as FineTuningJob['status'],
  progress: (r.progress as number | null) ?? null,
  metrics: (r.metrics as Record<string, unknown>) ?? {},
  resultModel: (r.result_model as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  createdAt: iso(r.created_at as Date)!,
  updatedAt: iso(r.updated_at as Date)!,
});

export const modelLabRepo = {
  // ---- configs ----
  async getConfig(db: Queryable, workspaceId: string, scope: ModelLabScope): Promise<ModelLabConfig | null> {
    const { rows } = await db.query('SELECT config FROM model_lab_configs WHERE workspace_id = $1 AND scope = $2', [workspaceId, scope]);
    return (rows[0]?.config as ModelLabConfig | undefined) ?? null;
  },
  async setConfig(db: Queryable, workspaceId: string, scope: ModelLabScope, config: ModelLabConfig, userId: string): Promise<void> {
    await db.query(
      `INSERT INTO model_lab_configs (workspace_id, scope, config, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, scope) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [workspaceId, scope, JSON.stringify(config), userId],
    );
  },

  // ---- deployments ----
  async listDeployments(db: Queryable, workspaceId: string): Promise<ModelDeployment[]> {
    const { rows } = await db.query('SELECT * FROM model_deployments WHERE workspace_id = $1 ORDER BY name', [workspaceId]);
    return rows.map(toDeployment);
  },
  async getDeployment(db: Queryable, workspaceId: string, name: string): Promise<ModelDeployment | null> {
    const { rows } = await db.query('SELECT * FROM model_deployments WHERE workspace_id = $1 AND name = $2', [workspaceId, name]);
    return rows[0] ? toDeployment(rows[0]) : null;
  },
  async upsertDeployment(
    db: Queryable,
    workspaceId: string,
    input: { name: string; model: string; parameters: ModelDeployment['parameters']; description: string; status: ModelDeployment['status'] },
    userId: string,
  ): Promise<ModelDeployment> {
    const { rows } = await db.query(
      `INSERT INTO model_deployments (workspace_id, name, model, parameters, description, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, name) DO UPDATE SET model = EXCLUDED.model, parameters = EXCLUDED.parameters,
         description = EXCLUDED.description, status = EXCLUDED.status, updated_at = now()
       RETURNING *`,
      [workspaceId, input.name, input.model, JSON.stringify(input.parameters), input.description, input.status, userId],
    );
    return toDeployment(rows[0]);
  },
  async deleteDeployment(db: Queryable, workspaceId: string, name: string): Promise<boolean> {
    const res = await db.query('DELETE FROM model_deployments WHERE workspace_id = $1 AND name = $2', [workspaceId, name]);
    return (res.rowCount ?? 0) > 0;
  },

  // ---- datasets ----
  async listDatasets(db: Queryable, workspaceId: string): Promise<Dataset[]> {
    const { rows } = await db.query(
      `SELECT d.*, count(e.id)::int AS examples, count(e.id) FILTER (WHERE e.reviewed)::int AS reviewed
         FROM fine_tuning_datasets d LEFT JOIN fine_tuning_examples e ON e.dataset_id = d.id
        WHERE d.workspace_id = $1 GROUP BY d.id ORDER BY d.updated_at DESC`,
      [workspaceId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      examples: r.examples,
      reviewed: r.reviewed,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    }));
  },
  async createDataset(db: Queryable, workspaceId: string, input: { name: string; description: string }, userId: string): Promise<string> {
    const { rows } = await db.query('INSERT INTO fine_tuning_datasets (workspace_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
      workspaceId,
      input.name,
      input.description,
      userId,
    ]);
    return rows[0].id;
  },
  async datasetExists(db: Queryable, workspaceId: string, id: string): Promise<boolean> {
    const { rows } = await db.query('SELECT 1 FROM fine_tuning_datasets WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
    return rows.length > 0;
  },
  async deleteDataset(db: Queryable, workspaceId: string, id: string): Promise<boolean> {
    const res = await db.query('DELETE FROM fine_tuning_datasets WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
    return (res.rowCount ?? 0) > 0;
  },
  async listExamples(db: Queryable, datasetId: string, limit = 500): Promise<DatasetExample[]> {
    const { rows } = await db.query('SELECT * FROM fine_tuning_examples WHERE dataset_id = $1 ORDER BY created_at LIMIT $2', [datasetId, limit]);
    return rows.map(toExample);
  },
  async addExample(
    db: Queryable,
    datasetId: string,
    input: { source: DatasetExample['source']; sourceRunId?: string; task: string; context?: string; output: string; expected?: string; outcome?: DatasetExample['outcome']; addedBy: string },
  ): Promise<DatasetExample> {
    const { rows } = await db.query(
      `INSERT INTO fine_tuning_examples (dataset_id, source, source_run_id, task, context, output, expected, outcome, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [datasetId, input.source, input.sourceRunId ?? null, input.task, input.context ?? null, input.output, input.expected ?? null, input.outcome ?? null, input.addedBy],
    );
    await db.query('UPDATE fine_tuning_datasets SET updated_at = now() WHERE id = $1', [datasetId]);
    return toExample(rows[0]);
  },
  async setReviewed(db: Queryable, datasetId: string, exampleId: string, reviewed: boolean): Promise<boolean> {
    const res = await db.query('UPDATE fine_tuning_examples SET reviewed = $3 WHERE id = $2 AND dataset_id = $1', [datasetId, exampleId, reviewed]);
    return (res.rowCount ?? 0) > 0;
  },
  async deleteExample(db: Queryable, datasetId: string, exampleId: string): Promise<boolean> {
    const res = await db.query('DELETE FROM fine_tuning_examples WHERE id = $2 AND dataset_id = $1', [datasetId, exampleId]);
    return (res.rowCount ?? 0) > 0;
  },

  // ---- evaluations ----
  async createEvaluation(db: Queryable, workspaceId: string, input: { name: string; datasetId: string; models: string[]; scorer: string }, userId: string): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO model_evaluations (workspace_id, name, dataset_id, models, scorer, status, created_by) VALUES ($1, $2, $3, $4, $5, 'queued', $6) RETURNING id`,
      [workspaceId, input.name, input.datasetId, input.models, input.scorer, userId],
    );
    return rows[0].id;
  },
  async getEvaluation(db: Queryable, id: string, workspaceId?: string): Promise<ModelEvaluation | null> {
    const { rows } = workspaceId
      ? await db.query('SELECT * FROM model_evaluations WHERE id = $1 AND workspace_id = $2', [id, workspaceId])
      : await db.query('SELECT * FROM model_evaluations WHERE id = $1', [id]);
    return rows[0] ? toEvaluation(rows[0]) : null;
  },
  async listEvaluations(db: Queryable, workspaceId: string): Promise<ModelEvaluation[]> {
    const { rows } = await db.query('SELECT * FROM model_evaluations WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50', [workspaceId]);
    return rows.map(toEvaluation);
  },
  async updateEvaluation(db: Queryable, id: string, patch: { status: ModelEvaluation['status']; results?: ModelEvaluationResult[]; error?: string }): Promise<void> {
    await db.query(
      `UPDATE model_evaluations SET status = $2, results = COALESCE($3, results), error = $4,
              completed_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() ELSE completed_at END
        WHERE id = $1`,
      [id, patch.status, patch.results ? JSON.stringify(patch.results) : null, patch.error ?? null],
    );
  },

  // ---- fine-tuning jobs ----
  async listJobs(db: Queryable, workspaceId: string): Promise<FineTuningJob[]> {
    const { rows } = await db.query('SELECT * FROM fine_tuning_jobs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50', [workspaceId]);
    return rows.map(toJob);
  },
};
