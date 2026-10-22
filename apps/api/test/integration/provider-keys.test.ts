import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_SCOPES, type ModelInfo, type ProviderKeysResponse } from '@neuroflow/contracts';
import { authRepo } from '@neuroflow/db';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { api, readSse, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();
const KEY = 'nf_byok_tenant_test_key_00000000000';
const TENANT_GROQ_KEY = 'gsk_tenant_good_key_0000000000wxyz';
const PLATFORM_GROQ_KEY = 'test'; // the harness's server-side Groq key

/** Bring-your-own-key end to end: store → verify → run with the tenant's key → isolation → delete. */
describe.skipIf(!reachable)('workspace provider keys (BYOK)', () => {
  let h: Harness;
  const tenant = (path: string, init: Parameters<typeof api>[2] = {}) => api(h, path, { ...init, key: KEY });
  const groqRun = async (call: typeof tenant) => {
    const res = await call('/v1/runs', { method: 'POST', json: { selectedModel: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hello from byok' }] } });
    expect(res.status).toBe(201);
    const id = (await res.json()).run.id as string;
    // Events are read as the run's own workspace (another workspace cannot see them).
    const events = (await readSse(await call(`/v1/runs/${id}/events`))).map((d) => JSON.parse(d) as { type: string });
    return events.at(-1)?.type;
  };

  beforeAll(async () => {
    h = await startHarness();
    const ids = await authRepo.ensureUserWithWorkspace(h.db.pool, { email: 'byok@example.test', displayName: 'BYOK', workspaceName: 'BYOK' });
    await authRepo.createApiKey(h.db.pool, { ...ids, name: 'byok', scopes: [...ALL_SCOPES], key: KEY });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    h.groq.keys.length = 0;
    h.groq.setValidKeys([PLATFORM_GROQ_KEY, TENANT_GROQ_KEY]);
  });

  it('lists the providers that take workspace keys', async () => {
    const body = (await (await tenant('/v1/provider-keys')).json()) as ProviderKeysResponse;
    expect(body).toMatchObject({ keys: [], platformKeysEnabled: true, canEdit: true });
    expect(body.providers).toContainEqual({ id: 'groq', displayName: 'Groq', platformKey: true });
  });

  it('refuses a key the provider rejects, and never stores it', async () => {
    const res = await tenant('/v1/provider-keys', { method: 'POST', json: { provider: 'groq', apiKey: 'gsk_wrong_key_000000000000' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Groq rejected this key/);
    expect((await (await tenant('/v1/provider-keys')).json()).keys).toEqual([]);
  });

  it('stores a verified key, shows only a hint, and refuses duplicates', async () => {
    const res = await tenant('/v1/provider-keys', { method: 'POST', json: { provider: 'groq', apiKey: TENANT_GROQ_KEY, label: 'Team key' } });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(TENANT_GROQ_KEY);
    expect(JSON.parse(text).key).toMatchObject({ provider: 'groq', label: 'Team key', hint: 'wxyz', status: 'active' });
    expect((await tenant('/v1/provider-keys', { method: 'POST', json: { provider: 'groq', apiKey: TENANT_GROQ_KEY } })).status).toBe(409);

    const listed = await (await tenant('/v1/provider-keys')).text();
    expect(listed).not.toContain(TENANT_GROQ_KEY);
    const models = (await (await tenant('/v1/model-lab/models')).json()).models as ModelInfo[];
    expect(models.find((m) => m.ref === 'groq/llama-3.3-70b-versatile')).toMatchObject({ available: true, keySource: 'workspace' });
  });

  it("runs call the provider with the workspace's key; other workspaces keep the platform key", async () => {
    expect(await groqRun(tenant)).toBe('run.completed');
    expect(h.groq.keys).toEqual([TENANT_GROQ_KEY]);
    expect(await groqRun((path, init) => api(h, path, init))).toBe('run.completed');
    expect(h.groq.keys).toEqual([TENANT_GROQ_KEY, PLATFORM_GROQ_KEY]);
  });

  it('re-verification marks a revoked key invalid, and runs stop using it', async () => {
    const [key] = (await (await tenant('/v1/provider-keys')).json()).keys;
    h.groq.setValidKeys([PLATFORM_GROQ_KEY]);
    const verified = await (await tenant(`/v1/provider-keys/${key.id}/verify`, { method: 'POST' })).json();
    expect(verified.key).toMatchObject({ status: 'invalid', lastError: 'The provider rejected this key' });
    // With no active workspace key the platform key serves the run (platform keys are enabled here).
    expect(await groqRun(tenant)).toBe('run.completed');
    expect(h.groq.keys).toEqual([PLATFORM_GROQ_KEY]);
  });

  it('deletes a key, and every change is audited without the key', async () => {
    const [key] = (await (await tenant('/v1/provider-keys')).json()).keys;
    expect((await tenant(`/v1/provider-keys/${key.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await (await tenant('/v1/provider-keys')).json()).keys).toEqual([]);
    expect((await tenant(`/v1/provider-keys/${key.id}`, { method: 'DELETE' })).status).toBe(404);

    const audit = await (await tenant('/v1/audit')).text();
    for (const action of ['provider_key.created', 'provider_key.verified', 'provider_key.deleted']) expect(audit).toContain(action);
    expect(audit).not.toContain(TENANT_GROQ_KEY);
  });

  it('members without admin rights cannot manage keys', async () => {
    const ids = await authRepo.ensureUserWithWorkspace(h.db.pool, { email: 'member@example.test', displayName: 'M', workspaceName: 'M' });
    const MEMBER = 'nf_byok_member_key_0000000000000000';
    await authRepo.createApiKey(h.db.pool, { ...ids, name: 'member', scopes: ALL_SCOPES.filter((s) => s !== 'admin'), key: MEMBER });
    const res = await api(h, '/v1/provider-keys', { method: 'POST', key: MEMBER, json: { provider: 'groq', apiKey: TENANT_GROQ_KEY } });
    expect(res.status).toBe(403);
    expect((await (await api(h, '/v1/provider-keys', { key: MEMBER })).json()).canEdit).toBe(false);
  });
});
