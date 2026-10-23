import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_SCOPES, type RunEvent, type WorkspaceBudget } from '@neuroflow/contracts';
import { auditRepo, authRepo } from '@neuroflow/db';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { api, readSse, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();
const KEY_A = 'nf_budget_tenant_a_key_000000000000';
const KEY_B = 'nf_budget_tenant_b_key_000000000000';
const TENANT_GROQ_KEY = 'gsk_budget_tenant_key_00000000abcd';

/**
 * Dollar budgets end to end: limits set through the API, spend charged by the worker after real
 * model calls, runs refused at the limit, and a provider key over budget skipped mid-run.
 */
describe.skipIf(!reachable)('dollar budgets', () => {
  let h: Harness;
  let wsA: string;
  let wsB: string;
  const as = (key: string) => (path: string, init: Parameters<typeof api>[2] = {}) => api(h, path, { ...init, key });
  const a = (path: string, init: Parameters<typeof api>[2] = {}) => as(KEY_A)(path, init);
  const b = (path: string, init: Parameters<typeof api>[2] = {}) => as(KEY_B)(path, init);

  const run = async (call: typeof a, selectedModel?: string) => {
    const res = await call('/v1/runs', {
      method: 'POST',
      json: { ...(selectedModel ? { selectedModel } : {}), agentStrategy: 'direct', messages: [{ role: 'user', content: 'what does this cost' }] },
    });
    if (res.status !== 201) return { status: res.status, body: await res.json() };
    const id = (await res.json()).run.id as string;
    const events = (await readSse(await call(`/v1/runs/${id}/events`))).map((d) => JSON.parse(d) as RunEvent);
    return { status: 201, id, events };
  };

  beforeAll(async () => {
    // A price high enough that one mock call costs dollars, so limits are crossed by real runs.
    h = await startHarness({ MODEL_PRICING: 'groq/llama-3.3-70b-versatile=100000:100000' });
    h.groq.setValidKeys(null);
    const ida = await authRepo.ensureUserWithWorkspace(h.db.pool, { email: 'budget-a@example.test', displayName: 'A', workspaceName: 'Budget A' });
    await authRepo.createApiKey(h.db.pool, { ...ida, name: 'a', scopes: [...ALL_SCOPES], key: KEY_A });
    const idb = await authRepo.ensureUserWithWorkspace(h.db.pool, { email: 'budget-b@example.test', displayName: 'B', workspaceName: 'Budget B' });
    await authRepo.createApiKey(h.db.pool, { ...idb, name: 'b', scopes: [...ALL_SCOPES], key: KEY_B });
    wsA = ida.workspaceId;
    wsB = idb.workspaceId;
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('starts without limits and validates new ones', async () => {
    const body = (await (await a('/v1/workspace/budget')).json()) as WorkspaceBudget;
    expect(body).toMatchObject({ monthlyLimitUsd: null, dailyLimitUsd: null, alertPercent: 80, spend: { todayUsd: 0, monthUsd: 0, unpricedCallsThisMonth: 0 }, canEdit: true });
    expect((await a('/v1/workspace/budget', { method: 'PUT', json: { monthlyLimitUsd: -5, dailyLimitUsd: null } })).status).toBe(400);
    expect((await a('/v1/workspace/budget', { method: 'PUT', json: { monthlyLimitUsd: 1.005, dailyLimitUsd: null } })).status).toBe(400);
    const saved = (await (await a('/v1/workspace/budget', { method: 'PUT', json: { monthlyLimitUsd: 1, dailyLimitUsd: null, alertPercent: 50 } })).json()) as WorkspaceBudget;
    expect(saved).toMatchObject({ monthlyLimitUsd: 1, dailyLimitUsd: null, alertPercent: 50 });
    const audit = await auditRepo.list(h.db.pool, wsA, { action: 'budget.updated' });
    expect(audit[0]?.metadata).toMatchObject({ monthlyLimitUsd: 1 });
  });

  it('charges each model call and refuses new runs once the monthly limit is reached', async () => {
    const first = await run(a, 'groq/llama-3.3-70b-versatile');
    expect(first.events?.at(-1)?.type).toBe('run.completed');
    const budget = (await (await a('/v1/workspace/budget')).json()) as WorkspaceBudget;
    expect(budget.spend.monthUsd).toBeGreaterThan(1);
    expect(budget.spend.todayUsd).toBe(budget.spend.monthUsd);

    const refused = await run(a);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('quota_exceeded');
    expect(refused.body.error.message).toMatch(/monthly spending limit of \$1\.00 is reached/);
    // The worker recorded the crossing once.
    const exceeded = await auditRepo.list(h.db.pool, wsA, { action: 'budget.exceeded' });
    expect(exceeded).toHaveLength(1);

    // Raising the limit lets work continue at once: the worker confirms a refusal with fresh budgets.
    await a('/v1/workspace/budget', { method: 'PUT', json: { monthlyLimitUsd: 1000, dailyLimitUsd: null } });
    expect((await run(a)).events?.at(-1)?.type).toBe('run.completed');
    // That run used the default model, self-hosted Qwen: free (cost 0), so not an unpriced call.
    const after = (await (await a('/v1/workspace/budget')).json()) as WorkspaceBudget;
    expect(after.spend.unpricedCallsThisMonth).toBe(0);
  });

  it('a provider key over its monthly budget is skipped, never replaced by the platform key', async () => {
    const created = await (await b('/v1/provider-keys', { method: 'POST', json: { provider: 'groq', apiKey: TENANT_GROQ_KEY } })).json();
    const keyId = created.key.id as string;
    const patched = await (await b(`/v1/provider-keys/${keyId}`, { method: 'PATCH', json: { monthlyBudgetUsd: 1 } })).json();
    expect(patched.key).toMatchObject({ monthlyBudgetUsd: 1, spendThisMonthUsd: 0 });

    h.groq.keys.length = 0;
    const first = await run(b, 'groq/llama-3.3-70b-versatile');
    expect(first.events?.at(-1)?.type).toBe('run.completed');
    expect(h.groq.keys).toEqual([TENANT_GROQ_KEY]);
    const listed = await (await b('/v1/provider-keys')).json();
    expect(listed.keys[0].spendThisMonthUsd).toBeGreaterThan(1);
    const calls = await h.db.pool.query('SELECT provider_key_id, workspace_id FROM model_calls WHERE run_id = $1', [first.id]);
    expect(calls.rows).toEqual([{ provider_key_id: keyId, workspace_id: wsB }]);

    // Next run: Groq is skipped for this workspace (its key is over budget) and the run falls back
    // to another provider; Groq receives no request at all, with either key.
    h.groq.keys.length = 0;
    const second = await run(b, 'groq/llama-3.3-70b-versatile');
    expect(h.groq.keys).toEqual([]);
    const completed = second.events?.filter((e) => e.type === 'model.completed').map((e) => (e.data as { provider: string }).provider);
    if (second.events?.at(-1)?.type === 'run.completed') {
      expect(completed).not.toContain('groq');
    } else {
      expect(second.events?.at(-1)).toMatchObject({ type: 'run.failed', data: { error: { code: 'spend_limit' } } });
    }

    // Removing the budget restores the key.
    await b(`/v1/provider-keys/${keyId}`, { method: 'PATCH', json: { monthlyBudgetUsd: null } });
  });
});
