import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_SCOPES, type UsageHistory } from '@neuroflow/contracts';
import { authRepo } from '@neuroflow/db';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { api, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();
const KEY = 'nf_usage_history_test_key_0000000000';
const DAY = 86_400_000;

/** Usage history aggregates recorded runs and model calls; data is inserted directly so every number is known. */
describe.skipIf(!reachable)('usage history', () => {
  let h: Harness;
  let workspaceId: string;
  let userId: string;
  let codeWorkspaceId: string;
  const get = (path: string) => api(h, path, { key: KEY });

  const insertRun = async (o: { daysAgo: number; status: string; source?: string; code?: { testsPassed: boolean | null } }) => {
    const created = new Date(Date.now() - o.daysAgo * DAY);
    const { rows } = await h.db.pool.query(
      `INSERT INTO runs (workspace_id, user_id, mode, status, requested_agent_strategy, requested_model_strategy, source, created_at)
       VALUES ($1, $2, 'standard', $3, 'auto', 'auto', $4, $5) RETURNING id`,
      [workspaceId, userId, o.status, o.source ?? 'workspace', created],
    );
    const runId = rows[0].id as string;
    if (o.code) {
      await h.db.pool.query(`INSERT INTO code_runs (run_id, code_workspace_id, approval_mode, tests_passed) VALUES ($1, $2, 'review', $3)`, [
        runId,
        codeWorkspaceId,
        o.code.testsPassed,
      ]);
    }
    return { runId, created };
  };
  const insertCall = (
    run: { runId: string; created: Date },
    c: { provider: string; model: string; prompt: number; completion: number; cost: number; latency: number; status?: string; fallbackFrom?: string },
  ) =>
    h.db.pool.query(
      `INSERT INTO model_calls (run_id, role, provider, model, status, latency_ms, prompt_tokens, completion_tokens, cost_usd, fallback_from, created_at)
       VALUES ($1, 'agent', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [run.runId, c.provider, c.model, c.status ?? 'completed', c.latency, c.prompt, c.completion, c.cost, c.fallbackFrom ?? null, run.created],
    );

  beforeAll(async () => {
    h = await startHarness();
    const ids = await authRepo.ensureUserWithWorkspace(h.db.pool, { email: 'usage@example.test', displayName: 'Usage', workspaceName: 'Usage workspace' });
    workspaceId = ids.workspaceId;
    userId = ids.userId;
    await authRepo.createApiKey(h.db.pool, { ...ids, name: 'usage', scopes: [...ALL_SCOPES], key: KEY });
    const repo = await h.db.pool.query(
      `INSERT INTO repository_bindings (workspace_id, provider, owner, name, default_branch, clone_url)
       VALUES ($1, 'github', 'acme', 'calc', 'main', 'https://github.com/acme/calc.git') RETURNING id`,
      [workspaceId],
    );
    const cw = await h.db.pool.query(
      `INSERT INTO code_workspaces (workspace_id, repository_id, created_by, branch, base_branch, status)
       VALUES ($1, $2, $3, 'main', 'main', 'ready') RETURNING id`,
      [workspaceId, repo.rows[0].id, userId],
    );
    codeWorkspaceId = cw.rows[0].id;

    // Today: a chat run with two model calls (one a fallback), an API run, and a failed code run.
    const chat = await insertRun({ daysAgo: 0, status: 'completed' });
    await insertCall(chat, { provider: 'groq', model: 'openai/gpt-oss-120b', prompt: 1000, completion: 200, cost: 0.00027, latency: 800 });
    await insertCall(chat, { provider: 'groq', model: 'openai/gpt-oss-20b', prompt: 500, completion: 100, cost: 0.000068, latency: 300, fallbackFrom: 'groq/openai/gpt-oss-120b' });
    const apiRun = await insertRun({ daysAgo: 0, status: 'completed', source: 'openai' });
    await insertCall(apiRun, { provider: 'qwen', model: 'qwen3:8b', prompt: 300, completion: 50, cost: 0, latency: 1200 });
    const failedCode = await insertRun({ daysAgo: 0, status: 'failed', code: { testsPassed: false } });
    await insertCall(failedCode, { provider: 'groq', model: 'openai/gpt-oss-120b', prompt: 2000, completion: 0, cost: 0.0003, latency: 5000, status: 'failed' });
    // Two days ago: a passing code run.
    const code = await insertRun({ daysAgo: 2, status: 'completed', code: { testsPassed: true } });
    await insertCall(code, { provider: 'groq', model: 'openai/gpt-oss-120b', prompt: 4000, completion: 800, cost: 0.00108, latency: 1500 });
    // Forty days ago: outside the 30-day window, inside 90 days.
    const old = await insertRun({ daysAgo: 40, status: 'cancelled' });
    await insertCall(old, { provider: 'groq', model: 'openai/gpt-oss-20b', prompt: 100, completion: 10, cost: 0.00001, latency: 200 });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('aggregates runs, tokens and cost by day, model, source and code workspace', async () => {
    const res = await get('/v1/workspace/usage/history?days=30');
    expect(res.status).toBe(200);
    const u = (await res.json()) as UsageHistory;

    expect(u.days).toBe(30);
    expect(u.totals).toMatchObject({
      runs: 4,
      completedRuns: 3,
      failedRuns: 1,
      cancelledRuns: 0,
      promptTokens: 7800,
      completionTokens: 1150,
      costUsd: 0.001718,
      modelCalls: 5,
      failedModelCalls: 1,
      fallbacks: 1,
      avgLatencyMs: 1760,
    });

    // One entry per day, oldest first, gaps included.
    expect(u.daily).toHaveLength(30);
    const today = new Date().toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    expect(u.daily.at(-1)).toMatchObject({ date: today, runs: 3, promptTokens: 3800, completionTokens: 350 });
    expect(u.daily.find((d) => d.date === twoDaysAgo)).toMatchObject({ runs: 1, promptTokens: 4000, costUsd: 0.00108 });
    expect(u.daily.filter((d) => d.runs === 0)).toHaveLength(28);

    // Most expensive model first, with latency figures.
    expect(u.byModel[0]).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-120b', calls: 3, failedCalls: 1, promptTokens: 7000, avgLatencyMs: 2433 });
    expect(u.byModel[0]!.p95LatencyMs).toBeGreaterThan(1500);
    expect(u.byModel.map((m) => m.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen3:8b']);

    const source = Object.fromEntries(u.bySource.map((s) => [s.source, s]));
    expect(source.chat).toMatchObject({ runs: 1, promptTokens: 1500, completionTokens: 300 });
    expect(source.code).toMatchObject({ runs: 2, promptTokens: 6000, completionTokens: 800 });
    expect(source.api).toMatchObject({ runs: 1, promptTokens: 300, costUsd: 0 });

    expect(u.byCodeWorkspace).toEqual([
      { codeWorkspaceId, repository: 'acme/calc', runs: 2, promptTokens: 6000, completionTokens: 800, costUsd: 0.00138, testsPassed: 1, testsFailed: 1 },
    ]);
  });

  it('wider windows include older runs; other workspaces never see this data', async () => {
    const u90 = (await (await get('/v1/workspace/usage/history?days=90')).json()) as UsageHistory;
    expect(u90.daily).toHaveLength(90);
    expect(u90.totals).toMatchObject({ runs: 5, cancelledRuns: 1, promptTokens: 7900 });

    const u7 = (await (await get('/v1/workspace/usage/history?days=7')).json()) as UsageHistory;
    expect(u7.totals.runs).toBe(4);

    // The harness's default workspace has its own (empty or unrelated) history.
    const other = (await (await api(h, '/v1/workspace/usage/history')).json()) as UsageHistory;
    expect(other.byCodeWorkspace.find((w) => w.codeWorkspaceId === codeWorkspaceId)).toBeUndefined();
    expect(other.days).toBe(30);
  });

  it('accepts only the offered windows', async () => {
    expect((await get('/v1/workspace/usage/history?days=5')).status).toBe(400);
    expect((await get('/v1/workspace/usage/history?days=abc')).status).toBe(400);
  });
});
