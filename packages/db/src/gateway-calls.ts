import type { ToolCall, Usage } from '@neuroflow/contracts';
import { withTransaction, type Pool } from './client';

export type GatewayCallRecord = {
  workspaceId: string;
  userId: string;
  scopes: string[];
  /** Request options as given (stored like a run's options; messages are not stored). */
  options: Record<string, unknown>;
  ref: string;
  provider: string;
  status: 'completed' | 'failed' | 'cancelled';
  output: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  finishReason?: string;
  error?: { code: string; message: string };
  latencyMs: number;
  firstTokenMs?: number;
  attempts: number;
  fallbackFrom?: string;
  providerKeyId?: string;
  /** Served from NeuroFlow's response cache: no provider call was made. */
  cacheHit?: boolean;
};

/**
 * Gateway-mode calls (one model call streamed from the API, no queue) are recorded after the
 * response as a completed `direct` run with one model call, so usage, budgets, history and the
 * delivery of webhooks treat them like any other run. Returns the run id.
 */
export async function recordGatewayCall(pool: Pool, c: GatewayCallRecord): Promise<string> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO runs (workspace_id, user_id, mode, status, requested_agent_strategy, requested_model_strategy, selected_model,
                         agent_strategy, model_strategy, task_class, request_options, output, output_tool_calls,
                         error_code, error_message, error_stage, prompt_tokens, completion_tokens, cost_usd,
                         source, principal_scopes, queued_at, started_at, completed_at, created_at)
       VALUES ($1, $2, 'standard', $3, 'direct', 'single', $4, 'direct', 'single', 'gateway', $5, $6, $7,
               $8, $9, $10, $11, $12, $13, 'openai', $14,
               now() - ($15::int * interval '1 millisecond'), now() - ($15::int * interval '1 millisecond'), now(),
               now() - ($15::int * interval '1 millisecond'))
       RETURNING id`,
      [
        c.workspaceId,
        c.userId,
        c.status,
        c.ref,
        JSON.stringify({ ...c.options, gateway: true, ...(c.cacheHit ? { cacheHit: true } : {}) }),
        c.output,
        c.toolCalls?.length ? JSON.stringify(c.toolCalls) : null,
        c.error?.code ?? null,
        c.error?.message ?? null,
        c.error ? 'model' : null,
        c.usage?.promptTokens ?? null,
        c.usage?.completionTokens ?? null,
        c.usage?.costUsd ?? null,
        c.scopes,
        Math.round(c.latencyMs),
      ],
    );
    const runId = rows[0].id as string;
    await tx.query(
      `INSERT INTO model_calls (run_id, role, provider, model, status, latency_ms, first_token_ms, prompt_tokens, completion_tokens,
                                attempts, fallback_from, finish_reason, error, cost_usd, workspace_id, provider_key_id, cached_prompt_tokens)
       VALUES ($1, 'gateway', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        runId,
        c.provider,
        c.ref,
        c.status,
        Math.round(c.latencyMs),
        c.firstTokenMs != null ? Math.round(c.firstTokenMs) : null,
        c.usage?.promptTokens ?? null,
        c.usage?.completionTokens ?? null,
        c.attempts,
        c.fallbackFrom ?? null,
        c.cacheHit ? 'cache_hit' : (c.finishReason ?? null),
        c.error?.message.slice(0, 500) ?? null,
        c.usage?.costUsd ?? null,
        c.workspaceId,
        c.providerKeyId ?? null,
        c.usage?.cachedPromptTokens ?? null,
      ],
    );
    return runId;
  });
}
