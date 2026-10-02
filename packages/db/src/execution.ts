import type { ToolResult, Usage } from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

/** Structured execution records used by the inspector and for analysis. */
export const executionRepo = {
  async startAgent(
    db: Queryable,
    input: { runId: string; agentId: string; role: string; model: string },
  ): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO agent_executions (run_id, agent_id, role, model, status) VALUES ($1, $2, $3, $4, 'running')
       RETURNING id`,
      [input.runId, input.agentId, input.role, input.model],
    );
    return rows[0].id;
  },

  async finishAgent(
    db: Queryable,
    id: string,
    input: { status: 'completed' | 'failed' | 'cancelled'; iterations: number; output?: string; error?: string },
  ): Promise<void> {
    await db.query(
      `UPDATE agent_executions SET status = $2, iterations = $3, output = $4, error = $5, completed_at = now()
        WHERE id = $1`,
      [id, input.status, input.iterations, input.output?.slice(0, 20_000) ?? null, input.error ?? null],
    );
  },

  async recordModelCall(
    db: Queryable,
    input: {
      runId: string;
      agentExecutionId?: string;
      role: string;
      provider: string;
      model: string;
      status: 'completed' | 'failed' | 'cancelled';
      latencyMs: number;
      firstTokenMs?: number;
      usage?: Usage;
      attempts: number;
      fallbackFrom?: string;
      finishReason?: string;
      error?: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO model_calls (run_id, agent_execution_id, role, provider, model, status, latency_ms, first_token_ms,
                                prompt_tokens, completion_tokens, attempts, fallback_from, finish_reason, error, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        input.runId,
        input.agentExecutionId ?? null,
        input.role,
        input.provider,
        input.model,
        input.status,
        Math.round(input.latencyMs),
        input.firstTokenMs != null ? Math.round(input.firstTokenMs) : null,
        input.usage?.promptTokens ?? null,
        input.usage?.completionTokens ?? null,
        input.attempts,
        input.fallbackFrom ?? null,
        input.finishReason ?? null,
        input.error ?? null,
        input.usage?.costUsd ?? null,
      ],
    );
  },

  async startToolCall(
    db: Queryable,
    input: {
      runId: string;
      agentExecutionId?: string;
      toolCallId: string;
      name: string;
      arguments: unknown;
      riskLevel?: string;
      approvalStatus: 'not_required' | 'pending';
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO tool_calls (run_id, agent_execution_id, tool_call_id, name, arguments, status, risk_level, approval_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (run_id, tool_call_id) DO NOTHING`,
      [
        input.runId,
        input.agentExecutionId ?? null,
        input.toolCallId,
        input.name,
        input.arguments === undefined ? null : JSON.stringify(input.arguments),
        input.approvalStatus === 'pending' ? 'pending_approval' : 'running',
        input.riskLevel ?? null,
        input.approvalStatus,
      ],
    );
  },

  async setToolApproval(
    db: Queryable,
    runId: string,
    toolCallId: string,
    status: 'approved' | 'denied' | 'expired',
  ): Promise<void> {
    await db.query(
      `UPDATE tool_calls SET approval_status = $3, status = CASE WHEN $3 = 'approved' THEN 'running' ELSE status END
        WHERE run_id = $1 AND tool_call_id = $2`,
      [runId, toolCallId, status],
    );
  },

  async finishToolCall(db: Queryable, runId: string, result: ToolResult, extra?: { diagnostic?: string }): Promise<void> {
    await db.query(
      `INSERT INTO tool_calls (run_id, tool_call_id, name, status, approval_status)
       VALUES ($1, $2, $3, 'running', 'not_required')
       ON CONFLICT (run_id, tool_call_id) DO NOTHING`,
      [runId, result.toolCallId, result.name],
    );
    await db.query(
      `UPDATE tool_calls SET status = $3, result = $4, error_code = $5, error_message = $6, attempts = $7,
              duration_ms = $8, completed_at = now()
        WHERE run_id = $1 AND tool_call_id = $2`,
      [
        runId,
        result.toolCallId,
        result.status,
        result.data !== undefined ? JSON.stringify(result.data) : extra?.diagnostic ? JSON.stringify({ diagnostic: extra.diagnostic }) : null,
        result.error?.code ?? null,
        result.error?.message ?? null,
        result.attempts,
        Math.round(result.durationMs),
      ],
    );
  },

  /** Completed side-effecting tool calls are never re-executed when a run is recovered. */
  async findCompletedToolCall(db: Queryable, runId: string, toolCallId: string): Promise<ToolResult | null> {
    const { rows } = await db.query(
      `SELECT * FROM tool_calls WHERE run_id = $1 AND tool_call_id = $2 AND status = 'success'`,
      [runId, toolCallId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      toolCallId: r.tool_call_id,
      name: r.name,
      status: 'success',
      data: r.result,
      durationMs: r.duration_ms ?? 0,
      attempts: r.attempts,
      truncated: false,
    };
  },

  async recordEvaluation(
    db: Queryable,
    input: {
      runId: string;
      agentExecutionId?: string;
      kind: string;
      iteration: number;
      verdict: 'passed' | 'failed' | 'needs_refinement';
      score?: number;
      issues: string[];
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO evaluations (run_id, agent_execution_id, kind, iteration, verdict, score, issues)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.runId,
        input.agentExecutionId ?? null,
        input.kind,
        input.iteration,
        input.verdict,
        input.score ?? null,
        input.issues,
      ],
    );
  },

  /** Aggregated execution details for the inspector. */
  async runDetails(db: Queryable, runId: string) {
    const [agents, models, tools, evals] = await Promise.all([
      db.query('SELECT * FROM agent_executions WHERE run_id = $1 ORDER BY started_at', [runId]),
      db.query('SELECT * FROM model_calls WHERE run_id = $1 ORDER BY created_at', [runId]),
      db.query('SELECT * FROM tool_calls WHERE run_id = $1 ORDER BY created_at', [runId]),
      db.query('SELECT * FROM evaluations WHERE run_id = $1 ORDER BY created_at', [runId]),
    ]);
    return {
      agents: agents.rows.map((r) => ({
        id: r.id as string,
        agentId: r.agent_id as string,
        role: r.role as string,
        model: r.model as string,
        status: r.status as string,
        iterations: r.iterations as number,
        error: r.error as string | null,
        startedAt: iso(r.started_at)!,
        completedAt: iso(r.completed_at),
      })),
      modelCalls: models.rows.map((r) => ({
        agentExecutionId: r.agent_execution_id as string | null,
        role: r.role as string,
        provider: r.provider as string,
        model: r.model as string,
        status: r.status as string,
        latencyMs: r.latency_ms as number,
        firstTokenMs: r.first_token_ms as number | null,
        promptTokens: r.prompt_tokens as number | null,
        completionTokens: r.completion_tokens as number | null,
        attempts: r.attempts as number,
        fallbackFrom: r.fallback_from as string | null,
        finishReason: r.finish_reason as string | null,
        error: r.error as string | null,
        costUsd: r.cost_usd != null ? Number(r.cost_usd) : null,
        createdAt: iso(r.created_at)!,
      })),
      toolCalls: tools.rows.map((r) => ({
        toolCallId: r.tool_call_id as string,
        name: r.name as string,
        status: r.status as string,
        riskLevel: r.risk_level as string | null,
        approvalStatus: r.approval_status as string | null,
        errorCode: r.error_code as string | null,
        durationMs: r.duration_ms as number | null,
        attempts: r.attempts as number,
        agentExecutionId: r.agent_execution_id as string | null,
        createdAt: iso(r.created_at)!,
      })),
      evaluations: evals.rows.map((r) => ({
        kind: r.kind as string,
        iteration: r.iteration as number,
        verdict: r.verdict as string,
        score: r.score as number | null,
        issues: r.issues as string[],
      })),
    };
  },
};

export type RunDetails = Awaited<ReturnType<typeof executionRepo.runDetails>>;
