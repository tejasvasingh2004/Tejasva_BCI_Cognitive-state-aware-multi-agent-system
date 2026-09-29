import type { ExecutionPlan, Run, RunError, RunRequest, Usage } from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

export type RunSource = 'workspace' | 'api' | 'openai';

export type RunRow = Run & { userId: string; source: RunSource };

const toRun = (r: Record<string, unknown>): RunRow => {
  const opts = (r.request_options ?? {}) as Record<string, unknown>;
  const error: RunError | null = r.error_code
    ? {
        code: r.error_code as string,
        message: (r.error_message as string) ?? '',
        ...(r.error_stage ? { stage: r.error_stage as string } : {}),
      }
    : null;
  const usage: Usage | null =
    r.prompt_tokens != null || r.completion_tokens != null
      ? {
          promptTokens: (r.prompt_tokens as number) ?? 0,
          completionTokens: (r.completion_tokens as number) ?? 0,
          totalTokens: ((r.prompt_tokens as number) ?? 0) + ((r.completion_tokens as number) ?? 0),
        }
      : null;
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    userId: r.user_id as string,
    source: r.source as RunSource,
    mode: r.mode as Run['mode'],
    status: r.status as Run['status'],
    request: {
      ...(opts as object),
      mode: r.mode as Run['mode'],
      agentStrategy: r.requested_agent_strategy as Run['request']['agentStrategy'],
      modelStrategy: r.requested_model_strategy as Run['request']['modelStrategy'],
      ...(r.selected_model ? { selectedModel: r.selected_model as string } : {}),
    } as Run['request'],
    executionPlan: (r.execution_plan as ExecutionPlan | null) ?? null,
    output: (r.output as string | null) ?? null,
    error,
    usage,
    attempt: r.attempt as number,
    createdAt: iso(r.created_at as Date)!,
    startedAt: iso(r.started_at as Date | null),
    completedAt: iso(r.completed_at as Date | null),
    cancelRequestedAt: iso(r.cancel_requested_at as Date | null),
  };
};

export type CreateRunInput = {
  workspaceId: string;
  userId: string;
  conversationId: string;
  request: RunRequest;
  source: RunSource;
  idempotencyKey?: string;
};

export const runsRepo = {
  /**
   * Inserts a run in `queued` state. With an idempotency key, a duplicate request returns the
   * existing run instead of creating a second execution.
   */
  async create(db: Queryable, input: CreateRunInput): Promise<{ run: RunRow; created: boolean }> {
    const { messages: _m, conversationId: _c, mode, agentStrategy, modelStrategy, selectedModel, ...options } =
      input.request;
    const { rows } = await db.query(
      `INSERT INTO runs (workspace_id, conversation_id, user_id, mode, status, requested_agent_strategy,
                         requested_model_strategy, selected_model, request_options, idempotency_key, source, queued_at)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.workspaceId,
        input.conversationId,
        input.userId,
        mode,
        agentStrategy,
        modelStrategy,
        selectedModel ?? null,
        JSON.stringify(options),
        input.idempotencyKey ?? null,
        input.source,
      ],
    );
    if (rows[0]) return { run: toRun(rows[0]), created: true };
    const existing = await db.query('SELECT * FROM runs WHERE workspace_id = $1 AND idempotency_key = $2', [
      input.workspaceId,
      input.idempotencyKey,
    ]);
    return { run: toRun(existing.rows[0]), created: false };
  },

  async get(db: Queryable, id: string, workspaceId?: string): Promise<RunRow | null> {
    const { rows } = workspaceId
      ? await db.query('SELECT * FROM runs WHERE id = $1 AND workspace_id = $2', [id, workspaceId])
      : await db.query('SELECT * FROM runs WHERE id = $1', [id]);
    return rows[0] ? toRun(rows[0]) : null;
  },

  async listByConversation(db: Queryable, conversationId: string): Promise<RunRow[]> {
    const { rows } = await db.query('SELECT * FROM runs WHERE conversation_id = $1 ORDER BY created_at', [
      conversationId,
    ]);
    return rows.map(toRun);
  },

  /** Transitions queued/running → running for a (re)attempt. Returns null if the run may not start. */
  async markStarted(db: Queryable, id: string): Promise<RunRow | null> {
    const { rows } = await db.query(
      `UPDATE runs SET status = 'running', started_at = COALESCE(started_at, now()), attempt = attempt + 1
        WHERE id = $1 AND status IN ('queued', 'running') AND cancel_requested_at IS NULL
        RETURNING *`,
      [id],
    );
    return rows[0] ? toRun(rows[0]) : null;
  },

  async setPlan(db: Queryable, id: string, plan: ExecutionPlan): Promise<void> {
    await db.query(
      `UPDATE runs SET execution_plan = $2, agent_strategy = $3, model_strategy = $4, task_class = $5 WHERE id = $1`,
      [id, JSON.stringify(plan), plan.agentStrategy, plan.modelStrategy, plan.taskClass],
    );
  },

  async complete(db: Queryable, id: string, output: string, usage?: Usage): Promise<boolean> {
    const res = await db.query(
      `UPDATE runs SET status = 'completed', output = $2, completed_at = now(),
              prompt_tokens = $3, completion_tokens = $4
        WHERE id = $1 AND status = 'running'`,
      [id, output, usage?.promptTokens ?? null, usage?.completionTokens ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  },

  async fail(db: Queryable, id: string, error: RunError, partialOutput?: string): Promise<boolean> {
    const res = await db.query(
      `UPDATE runs SET status = 'failed', error_code = $2, error_message = $3, error_stage = $4,
              output = COALESCE($5, output), completed_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, error.code, error.message, error.stage ?? null, partialOutput || null],
    );
    return (res.rowCount ?? 0) > 0;
  },

  async markCancelled(db: Queryable, id: string, partialOutput?: string): Promise<boolean> {
    const res = await db.query(
      `UPDATE runs SET status = 'cancelled', completed_at = now(), output = COALESCE($2, output),
              cancel_requested_at = COALESCE(cancel_requested_at, now())
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, partialOutput || null],
    );
    return (res.rowCount ?? 0) > 0;
  },

  /** Records a cancellation request. Returns the updated run (or null if not found / terminal). */
  async requestCancel(db: Queryable, id: string, workspaceId: string): Promise<RunRow | null> {
    const { rows } = await db.query(
      `UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, now())
        WHERE id = $1 AND workspace_id = $2 AND status IN ('queued', 'running')
        RETURNING *`,
      [id, workspaceId],
    );
    return rows[0] ? toRun(rows[0]) : null;
  },

  async isCancelRequested(db: Queryable, id: string): Promise<boolean> {
    const { rows } = await db.query('SELECT cancel_requested_at FROM runs WHERE id = $1', [id]);
    return Boolean(rows[0]?.cancel_requested_at);
  },

  async countActive(db: Queryable, workspaceId: string): Promise<number> {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM runs WHERE workspace_id = $1 AND status IN ('queued', 'running')`,
      [workspaceId],
    );
    return rows[0].n;
  },

  /** Runs stuck in queued/running longer than `olderThanMs` (used by the reconciler). */
  async findStale(db: Queryable, olderThanMs: number): Promise<RunRow[]> {
    const { rows } = await db.query(
      `SELECT * FROM runs
        WHERE status IN ('queued', 'running')
          AND COALESCE(started_at, queued_at, created_at) < now() - ($1::int * interval '1 millisecond')
        ORDER BY created_at LIMIT 100`,
      [olderThanMs],
    );
    return rows.map(toRun);
  },
};
