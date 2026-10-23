import type * as KmsSdk from '@aws-sdk/client-kms';
import { KeyRing, LocalKeyEncryptionKey, type KeyEncryptionKey } from './provider-keys';

type KekEnv = {
  KEK_PROVIDER?: string;
  AWS_KMS_KEY_ID?: string;
  AWS_REGION?: string;
  AWS_KMS_ENDPOINT?: string;
  VAULT_ADDR?: string;
  VAULT_TOKEN?: string;
  VAULT_TRANSIT_KEY?: string;
  VAULT_TRANSIT_MOUNT?: string;
  VAULT_NAMESPACE?: string;
};

/**
 * AWS KMS: the KEK never leaves KMS. Each data key is encrypted with `Encrypt` under a symmetric KMS
 * key, bound to its workspace through the KMS encryption context (logged in CloudTrail, required
 * again by `Decrypt`). Credentials come from the standard AWS chain (env, profile, instance role).
 */
export class AwsKmsKeyEncryptionKey implements KeyEncryptionKey {
  readonly id: string;
  private client?: Promise<{ send: (cmd: unknown) => Promise<Record<string, unknown>>; mod: typeof KmsSdk }>;

  constructor(private readonly opts: { keyId: string; region?: string; endpoint?: string; credentials?: { accessKeyId: string; secretAccessKey: string } }) {
    this.id = `aws-kms:${opts.keyId}`;
  }

  private kms() {
    // Loaded only when AWS KMS is configured.
    this.client ??= import('@aws-sdk/client-kms').then((mod) => {
      const c = new mod.KMSClient({
        ...(this.opts.region ? { region: this.opts.region } : {}),
        ...(this.opts.endpoint ? { endpoint: this.opts.endpoint } : {}),
        ...(this.opts.credentials ? { credentials: this.opts.credentials } : {}),
        maxAttempts: 3,
      });
      return { send: (cmd: unknown) => c.send(cmd as never) as unknown as Promise<Record<string, unknown>>, mod };
    });
    return this.client;
  }

  async wrap(dataKey: Buffer, context: string): Promise<string> {
    const { send, mod } = await this.kms();
    const out = await send(new mod.EncryptCommand({ KeyId: this.opts.keyId, Plaintext: dataKey, EncryptionContext: { 'neuroflow:context': context } }));
    const blob = out.CiphertextBlob as Uint8Array | undefined;
    if (!blob) throw new Error('AWS KMS returned no ciphertext');
    return `kms1.${Buffer.from(blob).toString('base64url')}`;
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    if (!wrapped.startsWith('kms1.')) throw new Error('Not an AWS KMS ciphertext');
    const { send, mod } = await this.kms();
    const out = await send(
      new mod.DecryptCommand({
        KeyId: this.opts.keyId,
        CiphertextBlob: Buffer.from(wrapped.slice(5), 'base64url'),
        EncryptionContext: { 'neuroflow:context': context },
      }),
    );
    const plain = out.Plaintext as Uint8Array | undefined;
    if (!plain) throw new Error('AWS KMS returned no plaintext');
    return Buffer.from(plain);
  }
}

/**
 * HashiCorp Vault (or OpenBao) Transit: encryption as a service, free and self-hostable. The data
 * key and its context are sealed together, and the context is checked on unwrap, so a wrapped key
 * copied to another workspace will not open (this works with any Transit key, derived or not).
 * Key versions and rotation are Vault's: ciphertexts name their version.
 */
export class VaultTransitKeyEncryptionKey implements KeyEncryptionKey {
  readonly id: string;

  constructor(
    private readonly opts: { address: string; token: string; key: string; mount?: string; namespace?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  ) {
    this.id = `vault:${opts.mount ?? 'transit'}/${opts.key}`;
  }

  private async call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, string>> {
    const url = `${this.opts.address.replace(/\/$/, '')}/v1/${this.opts.mount ?? 'transit'}/${op}/${encodeURIComponent(this.opts.key)}`;
    const res = await (this.opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vault-token': this.opts.token,
        ...(this.opts.namespace ? { 'x-vault-namespace': this.opts.namespace } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      // Vault error bodies never contain the plaintext; still, report only the status.
      throw new Error(`Vault Transit ${op} failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Record<string, string> };
    if (!json.data) throw new Error(`Vault Transit ${op} returned no data`);
    return json.data;
  }

  async wrap(dataKey: Buffer, context: string): Promise<string> {
    const payload = Buffer.from(JSON.stringify({ c: context, k: dataKey.toString('base64') }), 'utf8').toString('base64');
    const { ciphertext } = await this.call('encrypt', { plaintext: payload });
    if (!ciphertext?.startsWith('vault:')) throw new Error('Vault Transit returned no ciphertext');
    return ciphertext;
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    const { plaintext } = await this.call('decrypt', { ciphertext: wrapped });
    const parsed = JSON.parse(Buffer.from(plaintext ?? '', 'base64').toString('utf8')) as { c?: string; k?: string };
    if (parsed.c !== context || !parsed.k) throw new Error('Wrapped data key belongs to a different context');
    return Buffer.from(parsed.k, 'base64');
  }
}

export type KekProvider = 'local' | 'aws-kms' | 'vault';

/**
 * Builds the key ring from configuration:
 * - `KEK_PROVIDER=local` (default): `SECRETS_KEY` derives the KEK;
 * - `KEK_PROVIDER=aws-kms`: `AWS_KMS_KEY_ID` (key id, ARN or alias), `AWS_REGION`, optional
 *   `AWS_KMS_ENDPOINT`; credentials from the standard AWS chain;
 * - `KEK_PROVIDER=vault`: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_KEY`, optional
 *   `VAULT_TRANSIT_MOUNT` (default `transit`) and `VAULT_NAMESPACE`.
 * The local KEK stays in the ring so data keys wrapped before a migration still open.
 */
export function keyRingFromEnv(env: KekEnv, local: { secretsKey: string | undefined; fallbackSecret: string }): KeyRing {
  const localKek = LocalKeyEncryptionKey.fromEnv(local.secretsKey, local.fallbackSecret);
  const provider = (env.KEK_PROVIDER ?? 'local') as KekProvider;
  if (provider === 'local') return new KeyRing(localKek);
  if (provider === 'aws-kms') {
    if (!env.AWS_KMS_KEY_ID) throw new Error('KEK_PROVIDER=aws-kms requires AWS_KMS_KEY_ID');
    return new KeyRing(
      new AwsKmsKeyEncryptionKey({
        keyId: env.AWS_KMS_KEY_ID,
        ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
        ...(env.AWS_KMS_ENDPOINT ? { endpoint: env.AWS_KMS_ENDPOINT } : {}),
      }),
      [localKek],
    );
  }
  if (provider === 'vault') {
    if (!env.VAULT_ADDR || !env.VAULT_TOKEN || !env.VAULT_TRANSIT_KEY) {
      throw new Error('KEK_PROVIDER=vault requires VAULT_ADDR, VAULT_TOKEN and VAULT_TRANSIT_KEY');
    }
    return new KeyRing(
      new VaultTransitKeyEncryptionKey({
        address: env.VAULT_ADDR,
        token: env.VAULT_TOKEN,
        key: env.VAULT_TRANSIT_KEY,
        ...(env.VAULT_TRANSIT_MOUNT ? { mount: env.VAULT_TRANSIT_MOUNT } : {}),
        ...(env.VAULT_NAMESPACE ? { namespace: env.VAULT_NAMESPACE } : {}),
      }),
      [localKek],
    );
  }
  throw new Error(`Unknown KEK_PROVIDER "${provider}" (expected local, aws-kms or vault)`);
}
