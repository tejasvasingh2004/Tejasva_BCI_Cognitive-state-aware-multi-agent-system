import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authRepo, DuplicateProviderKeyError, LocalKeyEncryptionKey, ProviderKeyVault } from '../src';
import { createTestDatabase, isPostgresReachable } from '../src/testing';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('provider key vault (BYOK)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;
  let a: { userId: string; workspaceId: string };
  let b: { userId: string; workspaceId: string };
  const kek = new LocalKeyEncryptionKey(randomBytes(32));
  let vault: ProviderKeyVault;
  const SECRET = 'gsk_live_ABCDEFGHIJKLMNOPQRSTUVWX1234';

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    a = await authRepo.ensureUserWithWorkspace(pool, { email: 'a@vault.test', displayName: 'A', workspaceName: 'A' });
    b = await authRepo.ensureUserWithWorkspace(pool, { email: 'b@vault.test', displayName: 'B', workspaceName: 'B' });
    vault = new ProviderKeyVault(pool, kek);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('stores a key encrypted and only ever shows a hint', async () => {
    const info = await vault.create({ workspaceId: a.workspaceId, userId: a.userId, provider: 'groq', apiKey: SECRET, label: 'Production' });
    expect(info).toMatchObject({ provider: 'groq', label: 'Production', hint: '1234', status: 'active', lastError: null });
    expect(JSON.stringify(info)).not.toContain(SECRET);
    expect(JSON.stringify(await vault.list(a.workspaceId))).not.toContain(SECRET);

    // Nothing in the database holds the key in plaintext: not the key row, not the data key row.
    const raw = JSON.stringify((await pool.query('SELECT * FROM provider_keys')).rows) + JSON.stringify((await pool.query('SELECT * FROM workspace_data_keys')).rows);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(SECRET.slice(4, 20));
  });

  it('decrypts the newest active key per provider for a run, and records use', async () => {
    const newer = await vault.create({ workspaceId: a.workspaceId, userId: a.userId, provider: 'groq', apiKey: 'gsk_second_key_0000000000005678' });
    const creds = await vault.credentials(a.workspaceId);
    expect(creds).toEqual({ groq: { keyId: newer.id, apiKey: 'gsk_second_key_0000000000005678' } });
    expect(await vault.credentials(b.workspaceId)).toEqual({});
    expect(await vault.activeProviders(a.workspaceId)).toEqual(['groq']);
  });

  it('refuses the same key twice for a provider, but another workspace may store it', async () => {
    await expect(vault.create({ workspaceId: a.workspaceId, userId: a.userId, provider: 'groq', apiKey: SECRET })).rejects.toBeInstanceOf(DuplicateProviderKeyError);
    await expect(vault.create({ workspaceId: b.workspaceId, userId: b.userId, provider: 'groq', apiKey: SECRET })).resolves.toMatchObject({ hint: '1234' });
  });

  it('an invalid key is skipped for runs until it verifies again', async () => {
    const [newest] = (await vault.list(a.workspaceId)).filter((k) => k.hint === '5678');
    await vault.setStatus(a.workspaceId, newest!.id, { ok: false, message: 'The provider rejected this key' });
    const creds = await vault.credentials(a.workspaceId);
    expect(creds.groq!.apiKey).toBe(SECRET);
    await vault.setStatus(a.workspaceId, newest!.id, { ok: true });
    expect((await vault.credentials(a.workspaceId)).groq!.keyId).toBe(newest!.id);
  });

  it('ciphertext is bound to its workspace: moved to another row it will not decrypt', async () => {
    const [keyA] = (await vault.list(a.workspaceId)).filter((k) => k.hint === '1234');
    const [keyB] = await vault.list(b.workspaceId);
    const stolen = (await pool.query('SELECT ciphertext FROM provider_keys WHERE id = $1', [keyA!.id])).rows[0].ciphertext;
    await pool.query('UPDATE provider_keys SET ciphertext = $2 WHERE id = $1', [keyB!.id, stolen]);
    await expect(vault.credentials(b.workspaceId)).rejects.toThrow();
  });

  it('a different key-encryption key cannot open the data keys', async () => {
    const other = new ProviderKeyVault(pool, new LocalKeyEncryptionKey(randomBytes(32)));
    await expect(other.credentials(a.workspaceId)).rejects.toThrow(/wrapped by KEK/);
  });

  it('deletes a key', async () => {
    const [first] = await vault.list(a.workspaceId);
    expect(await vault.delete(a.workspaceId, first!.id)).toMatchObject({ id: first!.id });
    expect(await vault.delete(b.workspaceId, first!.id)).toBeNull();
  });
});
