import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as KmsSdk from '@aws-sdk/client-kms';
import { KeyRing, LocalKeyEncryptionKey, type KeyEncryptionKey } from './provider-keys';

type KekEnv = {
  KEK_PROVIDER?: string;
  GCP_KMS_KEY_NAME?: string;
  GCP_KMS_ENDPOINT?: string;
  GCP_KMS_CREDENTIALS_JSON?: string;
  GOOGLE_APPLICATION_CREDENTIALS?: string;
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

/** The fields of a Google service-account key file that token requests need. */
export type GcpServiceAccount = { client_email: string; private_key: string; token_uri?: string };

/**
 * Google Cloud KMS through its REST API (no SDK): `cryptoKeys.encrypt` / `decrypt` with the
 * workspace context as additional authenticated data, which Cloud KMS requires again on decrypt.
 * Access tokens come from a service-account key (signed JWT exchanged at its token URI) or, without
 * one, from the GCE / Cloud Run metadata server; they are cached until shortly before expiry and
 * never logged.
 */
export class GcpKmsKeyEncryptionKey implements KeyEncryptionKey {
  readonly id: string;
  private token?: { value: string; expires: number };

  constructor(
    private readonly opts: {
      /** projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k> */
      keyName: string;
      credentials?: GcpServiceAccount;
      endpoint?: string;
      metadataUrl?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(opts.keyName)) {
      throw new Error('GCP_KMS_KEY_NAME must look like projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>');
    }
    this.id = `gcp-kms:${opts.keyName}`;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private get fetch() {
    return this.opts.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires - 60_000 > this.now()) return this.token.value;
    let res: Response;
    const sa = this.opts.credentials;
    if (sa) {
      const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
      const iat = Math.floor(this.now() / 1000);
      const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloudkms', aud: tokenUri, iat, exp: iat + 3600 })}`;
      const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
      res = await this.fetch(tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      res = await this.fetch(this.opts.metadataUrl ?? 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(5_000),
      });
    }
    if (!res.ok) throw new Error(`Google access token request failed with HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Google access token response had no token');
    this.token = { value: body.access_token, expires: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, string>> {
    const url = `${(this.opts.endpoint ?? 'https://cloudkms.googleapis.com').replace(/\/$/, '')}/v1/${this.opts.keyName}:${op}`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) this.token = undefined;
    if (!res.ok) throw new Error(`Cloud KMS ${op} failed with HTTP ${res.status}`);
    return (await res.json()) as Record<string, string>;
  }

  async wrap(dataKey: Buffer, context: string): Promise<string> {
    const { ciphertext } = await this.call('encrypt', { plaintext: dataKey.toString('base64'), additionalAuthenticatedData: Buffer.from(context).toString('base64') });
    if (!ciphertext) throw new Error('Cloud KMS returned no ciphertext');
    return `gcpkms1.${ciphertext}`;
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    if (!wrapped.startsWith('gcpkms1.')) throw new Error('Not a Cloud KMS ciphertext');
    const { plaintext } = await this.call('decrypt', { ciphertext: wrapped.slice(8), additionalAuthenticatedData: Buffer.from(context).toString('base64') });
    if (!plaintext) throw new Error('Cloud KMS returned no plaintext');
    return Buffer.from(plaintext, 'base64');
  }
}

export type KekProvider = 'local' | 'aws-kms' | 'vault' | 'gcp-kms';

/**
 * Builds the key ring from configuration:
 * - `KEK_PROVIDER=local` (default): `SECRETS_KEY` derives the KEK;
 * - `KEK_PROVIDER=aws-kms`: `AWS_KMS_KEY_ID` (key id, ARN or alias), `AWS_REGION`, optional
 *   `AWS_KMS_ENDPOINT`; credentials from the standard AWS chain;
 * - `KEK_PROVIDER=vault`: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_KEY`, optional
 *   `VAULT_TRANSIT_MOUNT` (default `transit`) and `VAULT_NAMESPACE`;
 * - `KEK_PROVIDER=gcp-kms`: `GCP_KMS_KEY_NAME`; a service-account key from
 *   `GOOGLE_APPLICATION_CREDENTIALS` (file) or `GCP_KMS_CREDENTIALS_JSON`, else the metadata server.
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
  if (provider === 'gcp-kms') {
    if (!env.GCP_KMS_KEY_NAME) throw new Error('KEK_PROVIDER=gcp-kms requires GCP_KMS_KEY_NAME');
    const raw = env.GCP_KMS_CREDENTIALS_JSON || (env.GOOGLE_APPLICATION_CREDENTIALS ? readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8') : undefined);
    let credentials: GcpServiceAccount | undefined;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GcpServiceAccount>;
      if (!parsed.client_email || !parsed.private_key) throw new Error('The Google service-account key needs client_email and private_key');
      credentials = { client_email: parsed.client_email, private_key: parsed.private_key, ...(parsed.token_uri ? { token_uri: parsed.token_uri } : {}) };
    }
    return new KeyRing(
      new GcpKmsKeyEncryptionKey({
        keyName: env.GCP_KMS_KEY_NAME,
        ...(credentials ? { credentials } : {}),
        ...(env.GCP_KMS_ENDPOINT ? { endpoint: env.GCP_KMS_ENDPOINT } : {}),
      }),
      [localKek],
    );
  }
  throw new Error(`Unknown KEK_PROVIDER "${provider}" (expected local, aws-kms, vault or gcp-kms)`);
}
