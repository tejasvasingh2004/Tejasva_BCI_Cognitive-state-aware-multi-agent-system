import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption (AES-256-GCM) for credentials at rest, e.g. GitHub tokens.
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    this.key = key;
  }

  /** `SECRETS_KEY` (base64, 32 bytes) or, outside production, a key derived from a fallback secret. */
  static fromEnv(secretsKey: string | undefined, fallbackSecret: string): SecretBox {
    if (secretsKey) {
      const key = Buffer.from(secretsKey, 'base64');
      if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
      return new SecretBox(key);
    }
    return new SecretBox(createHash('sha256').update(`neuroflow-secrets:${fallbackSecret}`).digest());
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
