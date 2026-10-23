import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authRepo,
  AwsKmsKeyEncryptionKey,
  keyRingFromEnv,
  KeyRing,
  LocalKeyEncryptionKey,
  ProviderKeyVault,
  VaultTransitKeyEncryptionKey,
} from '../src';
import { createTestDatabase, isPostgresReachable } from '../src/testing';

const pgReachable = await isPostgresReachable();

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Vault Transit double: keeps plaintexts server-side and hands out opaque `vault:v1:` ciphertexts. */
function vaultServer(token: string) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    const json = JSON.parse((await body(req)) || '{}') as Record<string, string>;
    calls.push(`${req.method} ${req.url}`);
    if (req.headers['x-vault-token'] !== token) return void res.writeHead(403).end('{"errors":["permission denied"]}');
    if (req.url === '/v1/transit/encrypt/neuroflow') {
      const id = randomUUID();
      store.set(id, json.plaintext!);
      return void res.end(JSON.stringify({ data: { ciphertext: `vault:v1:${id}` } }));
    }
    if (req.url === '/v1/transit/decrypt/neuroflow') {
      const plaintext = store.get(String(json.ciphertext).replace('vault:v1:', ''));
      if (!plaintext) return void res.writeHead(400).end('{"errors":["invalid ciphertext"]}');
      return void res.end(JSON.stringify({ data: { plaintext } }));
    }
    res.writeHead(404).end();
  });
  return { server, calls };
}

/** AWS KMS double (JSON 1.1 protocol): Encrypt/Decrypt with the encryption context enforced. */
function kmsServer() {
  const store = new Map<string, { plaintext: string; context: string }>();
  const server = createServer(async (req, res) => {
    const target = String(req.headers['x-amz-target'] ?? '');
    const json = JSON.parse((await body(req)) || '{}') as { Plaintext?: string; CiphertextBlob?: string; EncryptionContext?: Record<string, string>; KeyId?: string };
    res.setHeader('content-type', 'application/x-amz-json-1.1');
    const context = JSON.stringify(json.EncryptionContext ?? {});
    if (target === 'TrentService.Encrypt') {
      const id = randomUUID();
      store.set(id, { plaintext: json.Plaintext!, context });
      return void res.end(JSON.stringify({ CiphertextBlob: Buffer.from(id).toString('base64'), KeyId: json.KeyId }));
    }
    if (target === 'TrentService.Decrypt') {
      const entry = store.get(Buffer.from(json.CiphertextBlob ?? '', 'base64').toString());
      if (!entry || entry.context !== context) {
        res.writeHead(400);
        return void res.end(JSON.stringify({ __type: 'InvalidCiphertextException', message: 'context mismatch' }));
      }
      return void res.end(JSON.stringify({ Plaintext: entry.plaintext, KeyId: json.KeyId }));
    }
    res.writeHead(400).end(JSON.stringify({ __type: 'UnknownOperationException' }));
  });
  return { server };
}

describe('KMS key-encryption keys', () => {
  const vault = vaultServer('vault-token');
  const kms = kmsServer();
  let vaultUrl: string;
  let kmsUrl: string;

  beforeAll(async () => {
    vaultUrl = await listen(vault.server);
    kmsUrl = await listen(kms.server);
  });
  afterAll(() => {
    vault.server.close();
    kms.server.close();
  });

  it('Vault Transit wraps and unwraps a data key bound to its context', async () => {
    const kek = new VaultTransitKeyEncryptionKey({ address: vaultUrl, token: 'vault-token', key: 'neuroflow' });
    expect(kek.id).toBe('vault:transit/neuroflow');
    const dek = randomBytes(32);
    const wrapped = await kek.wrap(dek, 'nf-dek:ws-1');
    expect(wrapped).toMatch(/^vault:v1:/);
    expect(wrapped).not.toContain(dek.toString('base64'));
    expect((await kek.unwrap(wrapped, 'nf-dek:ws-1')).equals(dek)).toBe(true);
    await expect(kek.unwrap(wrapped, 'nf-dek:ws-2')).rejects.toThrow(/different context/);
    const denied = new VaultTransitKeyEncryptionKey({ address: vaultUrl, token: 'wrong', key: 'neuroflow' });
    await expect(denied.wrap(dek, 'x')).rejects.toThrow('Vault Transit encrypt failed with HTTP 403');
  });

  it('AWS KMS wraps with an encryption context that Decrypt requires', async () => {
    const kek = new AwsKmsKeyEncryptionKey({
      keyId: 'alias/neuroflow',
      region: 'us-east-1',
      endpoint: kmsUrl,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'test-secret' },
    });
    expect(kek.id).toBe('aws-kms:alias/neuroflow');
    const dek = randomBytes(32);
    const wrapped = await kek.wrap(dek, 'nf-dek:ws-1');
    expect(wrapped).toMatch(/^kms1\./);
    expect((await kek.unwrap(wrapped, 'nf-dek:ws-1')).equals(dek)).toBe(true);
    await expect(kek.unwrap(wrapped, 'nf-dek:ws-2')).rejects.toThrow();
  });

  it('builds the key ring from configuration and refuses incomplete settings', () => {
    const local = { secretsKey: randomBytes(32).toString('base64'), fallbackSecret: 'x'.repeat(32) };
    expect(keyRingFromEnv({}, local).primary.id).toMatch(/^local:/);
    const ring = keyRingFromEnv({ KEK_PROVIDER: 'vault', VAULT_ADDR: vaultUrl, VAULT_TOKEN: 't', VAULT_TRANSIT_KEY: 'neuroflow' }, local);
    expect(ring.primary.id).toBe('vault:transit/neuroflow');
    // The local KEK stays available for data keys wrapped before the migration.
    expect(ring.get(keyRingFromEnv({}, local).primary.id)).toBeDefined();
    expect(() => keyRingFromEnv({ KEK_PROVIDER: 'aws-kms' }, local)).toThrow(/AWS_KMS_KEY_ID/);
    expect(() => keyRingFromEnv({ KEK_PROVIDER: 'vault', VAULT_ADDR: vaultUrl }, local)).toThrow(/VAULT_TOKEN/);
    expect(() => keyRingFromEnv({ KEK_PROVIDER: 'hsm' }, local)).toThrow(/Unknown KEK_PROVIDER/);
  });

  describe.skipIf(!pgReachable)('migrating stored keys to a KMS', () => {
    let db: Awaited<ReturnType<typeof createTestDatabase>>;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('keeps every key readable, re-wraps data keys with the new KEK on use and in bulk', async () => {
      const local = new LocalKeyEncryptionKey(randomBytes(32));
      const vaultKek = new VaultTransitKeyEncryptionKey({ address: vaultUrl, token: 'vault-token', key: 'neuroflow' });
      const a = await authRepo.ensureUserWithWorkspace(db.pool, { email: 'a@kms.test', displayName: 'A', workspaceName: 'A' });
      const b = await authRepo.ensureUserWithWorkspace(db.pool, { email: 'b@kms.test', displayName: 'B', workspaceName: 'B' });
      const before = new ProviderKeyVault(db.pool, local);
      await before.create({ workspaceId: a.workspaceId, userId: a.userId, provider: 'groq', apiKey: 'gsk_workspace_a_key_0001' });
      await before.create({ workspaceId: b.workspaceId, userId: b.userId, provider: 'groq', apiKey: 'gsk_workspace_b_key_0002' });

      // Without the old KEK the keys cannot be opened, and the error says why.
      await expect(new ProviderKeyVault(db.pool, vaultKek).credentials(a.workspaceId)).rejects.toThrow(/not configured/);

      const after = new ProviderKeyVault(db.pool, new KeyRing(vaultKek, [local]));
      expect((await after.credentials(a.workspaceId)).groq?.apiKey).toBe('gsk_workspace_a_key_0001');
      const kekIds = async () => Object.fromEntries((await db.pool.query('SELECT workspace_id, kek_id FROM workspace_data_keys')).rows.map((r) => [r.workspace_id, r.kek_id]));
      expect(await kekIds()).toEqual({ [a.workspaceId]: vaultKek.id, [b.workspaceId]: local.id });

      expect(await after.rewrapAll()).toEqual({ total: 2, rewrapped: 1 });
      expect(await kekIds()).toEqual({ [a.workspaceId]: vaultKek.id, [b.workspaceId]: vaultKek.id });
      // Once everything is re-wrapped the old KEK is no longer needed.
      expect((await new ProviderKeyVault(db.pool, vaultKek).credentials(b.workspaceId)).groq?.apiKey).toBe('gsk_workspace_b_key_0002');
    });
  });
});
