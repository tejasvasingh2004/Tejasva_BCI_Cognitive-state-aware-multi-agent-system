import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ProviderKeyInfo } from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

/**
 * Key-encryption key (KEK) for envelope encryption. Wraps each workspace's data key; the data keys
 * encrypt the provider keys. Implement this over a cloud KMS (AWS KMS, Google Cloud KMS, Vault
 * Transit) to keep the KEK out of the application entirely; `LocalKeyEncryptionKey` is the
 * SECRETS_KEY-based default.
 */
export interface KeyEncryptionKey {
  /** Stable id of the KEK version, stored beside each wrapped data key. */
  readonly id: string;
  wrap(dataKey: Buffer, context: string): Promise<string>;
  unwrap(wrapped: string, context: string): Promise<Buffer>;
}

const seal = (key: Buffer, plaintext: Buffer, aad: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
};

const open = (key: Buffer, sealed: string, aad: string): Buffer => {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
};

/** KEK from `SECRETS_KEY` (base64, 32 bytes); outside production, derived from a fallback secret. */
export class LocalKeyEncryptionKey implements KeyEncryptionKey {
  readonly id: string;

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Key-encryption key must be 32 bytes');
    this.id = `local:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  }

  static fromEnv(secretsKey: string | undefined, fallbackSecret: string): LocalKeyEncryptionKey {
    if (secretsKey) {
      const key = Buffer.from(secretsKey, 'base64');
      if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
      // A distinct key for wrapping data keys, so this KEK is never the key that seals other secrets.
      return new LocalKeyEncryptionKey(createHmac('sha256', key).update('neuroflow-kek-v1').digest());
    }
    return new LocalKeyEncryptionKey(createHash('sha256').update(`neuroflow-kek:${fallbackSecret}`).digest());
  }

  async wrap(dataKey: Buffer, context: string): Promise<string> {
    return seal(this.key, dataKey, context);
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    return open(this.key, wrapped, context);
  }
}

export class DuplicateProviderKeyError extends Error {
  constructor() {
    super('This key is already stored for this provider');
  }
}

export type ProviderCredentials = Record<string, { keyId: string; apiKey: string }>;

const toInfo = (r: Record<string, unknown>): ProviderKeyInfo => ({
  id: r.id as string,
  provider: r.provider as string,
  label: r.label as string,
  hint: r.hint as string,
  status: r.status as ProviderKeyInfo['status'],
  lastError: (r.last_error as string | null) ?? null,
  createdAt: iso(r.created_at as Date)!,
  lastUsedAt: iso(r.last_used_at as Date | null) ?? null,
  lastVerifiedAt: iso(r.last_verified_at as Date | null) ?? null,
});

const PUBLIC_COLUMNS = 'id, provider, label, hint, status, last_error, created_at, last_used_at, last_verified_at';

/**
 * Workspace provider keys (BYOK) with envelope encryption:
 * - each workspace gets a random 256-bit data key, stored only wrapped by the KEK;
 * - each provider key is sealed with AES-256-GCM under the data key, bound by its authenticated
 *   data to workspace, provider and key id, so a ciphertext copied to another row will not open;
 * - reads for display return `ProviderKeyInfo` (a 4-character hint), never the key; only
 *   `credentials()` decrypts, and only the worker calls it, at run time.
 */
export class ProviderKeyVault {
  private readonly dataKeys = new Map<string, { key: Buffer; expires: number }>();

  constructor(
    private readonly db: Queryable,
    private readonly kek: KeyEncryptionKey,
    private readonly opts: { dataKeyCacheMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** The workspace's data key, created on first use (race-safe), cached briefly in memory. */
  private async dataKey(workspaceId: string): Promise<Buffer> {
    const cached = this.dataKeys.get(workspaceId);
    if (cached && cached.expires > this.now()) return cached.key;
    const context = `nf-dek:${workspaceId}`;
    let row = (await this.db.query('SELECT kek_id, wrapped_key FROM workspace_data_keys WHERE workspace_id = $1', [workspaceId])).rows[0];
    if (!row) {
      const fresh = randomBytes(32);
      await this.db.query(
        'INSERT INTO workspace_data_keys (workspace_id, kek_id, wrapped_key) VALUES ($1, $2, $3) ON CONFLICT (workspace_id) DO NOTHING',
        [workspaceId, this.kek.id, await this.kek.wrap(fresh, context)],
      );
      row = (await this.db.query('SELECT kek_id, wrapped_key FROM workspace_data_keys WHERE workspace_id = $1', [workspaceId])).rows[0];
    }
    if (row.kek_id !== this.kek.id) throw new Error(`Data key of workspace was wrapped by KEK ${row.kek_id}, not the configured ${this.kek.id}`);
    const key = await this.kek.unwrap(row.wrapped_key as string, context);
    this.dataKeys.set(workspaceId, { key, expires: this.now() + (this.opts.dataKeyCacheMs ?? 5 * 60_000) });
    return key;
  }

  private static aad(workspaceId: string, provider: string, id: string) {
    return `nf-provider-key:${workspaceId}:${provider}:${id}`;
  }

  async create(input: { workspaceId: string; userId: string | null; provider: string; apiKey: string; label?: string }): Promise<ProviderKeyInfo> {
    const dek = await this.dataKey(input.workspaceId);
    const id = randomUUID();
    const fingerprint = createHmac('sha256', dek).update(`${input.provider}:${input.apiKey}`).digest('hex');
    const ciphertext = seal(dek, Buffer.from(input.apiKey, 'utf8'), ProviderKeyVault.aad(input.workspaceId, input.provider, id));
    try {
      const { rows } = await this.db.query(
        `INSERT INTO provider_keys (id, workspace_id, provider, label, ciphertext, hint, fingerprint, created_by, last_verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         RETURNING ${PUBLIC_COLUMNS}`,
        [id, input.workspaceId, input.provider, input.label?.trim() || `${input.provider} key`, ciphertext, input.apiKey.slice(-4), fingerprint, input.userId],
      );
      return toInfo(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new DuplicateProviderKeyError();
      throw err;
    }
  }

  async list(workspaceId: string): Promise<ProviderKeyInfo[]> {
    const { rows } = await this.db.query(`SELECT ${PUBLIC_COLUMNS} FROM provider_keys WHERE workspace_id = $1 ORDER BY provider, created_at DESC`, [workspaceId]);
    return rows.map(toInfo);
  }

  async delete(workspaceId: string, id: string): Promise<ProviderKeyInfo | null> {
    const { rows } = await this.db.query(`DELETE FROM provider_keys WHERE workspace_id = $1 AND id = $2 RETURNING ${PUBLIC_COLUMNS}`, [workspaceId, id]);
    return rows[0] ? toInfo(rows[0]) : null;
  }

  /** Decrypts one key (re-verification). */
  async reveal(workspaceId: string, id: string): Promise<{ provider: string; apiKey: string } | null> {
    const { rows } = await this.db.query('SELECT provider, ciphertext FROM provider_keys WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
    const row = rows[0];
    if (!row) return null;
    const dek = await this.dataKey(workspaceId);
    return { provider: row.provider, apiKey: open(dek, row.ciphertext, ProviderKeyVault.aad(workspaceId, row.provider, id)).toString('utf8') };
  }

  async setStatus(workspaceId: string, id: string, result: { ok: true } | { ok: false; message: string }): Promise<ProviderKeyInfo | null> {
    const { rows } = await this.db.query(
      `UPDATE provider_keys SET status = $3, last_error = $4, last_verified_at = now()
        WHERE workspace_id = $1 AND id = $2 RETURNING ${PUBLIC_COLUMNS}`,
      [workspaceId, id, result.ok ? 'active' : 'invalid', result.ok ? null : result.message.slice(0, 300)],
    );
    return rows[0] ? toInfo(rows[0]) : null;
  }

  /** Providers with an active key, without decrypting anything (model availability for the UI). */
  async activeProviders(workspaceId: string): Promise<string[]> {
    const { rows } = await this.db.query("SELECT DISTINCT provider FROM provider_keys WHERE workspace_id = $1 AND status = 'active'", [workspaceId]);
    return rows.map((r) => r.provider as string);
  }

  /**
   * The newest active key per provider, decrypted, for one run. Marks them used. Only the worker
   * calls this; the result must never be logged, persisted or sent to a model.
   */
  async credentials(workspaceId: string): Promise<ProviderCredentials> {
    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (provider) id, provider, ciphertext FROM provider_keys
        WHERE workspace_id = $1 AND status = 'active' ORDER BY provider, created_at DESC`,
      [workspaceId],
    );
    if (!rows.length) return {};
    const dek = await this.dataKey(workspaceId);
    const out: ProviderCredentials = {};
    for (const r of rows) {
      out[r.provider] = { keyId: r.id, apiKey: open(dek, r.ciphertext, ProviderKeyVault.aad(workspaceId, r.provider, r.id)).toString('utf8') };
    }
    void this.db
      .query('UPDATE provider_keys SET last_used_at = now() WHERE id = ANY($1::uuid[]) AND (last_used_at IS NULL OR last_used_at < now() - interval \'1 minute\')', [rows.map((r) => r.id)])
      .catch(() => {});
    return out;
  }
}
