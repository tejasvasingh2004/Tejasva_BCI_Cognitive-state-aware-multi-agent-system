import { z } from 'zod';

/**
 * Bring-your-own-key: a workspace's own provider API keys. The key itself is write-only — after
 * it is stored the API only ever returns this public view (a 4-character hint, never the key).
 */
export const ProviderKeyStatus = z.enum(['active', 'invalid']);
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatus>;

export const ProviderKeyInfo = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  label: z.string(),
  /** Last four characters, to tell keys apart. */
  hint: z.string(),
  status: ProviderKeyStatus,
  lastError: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
});
export type ProviderKeyInfo = z.infer<typeof ProviderKeyInfo>;

export const CreateProviderKeyBody = z.object({
  provider: z.string().min(1).max(64),
  apiKey: z.string().trim().min(8).max(512),
  label: z.string().trim().min(1).max(80).optional(),
});
export type CreateProviderKeyBody = z.infer<typeof CreateProviderKeyBody>;

/** Providers that accept workspace keys, and whether the platform also has a key for them. */
export const KeyProvider = z.object({
  id: z.string(),
  displayName: z.string(),
  platformKey: z.boolean(),
});
export type KeyProvider = z.infer<typeof KeyProvider>;

export const ProviderKeysResponse = z.object({
  providers: z.array(KeyProvider),
  keys: z.array(ProviderKeyInfo),
  /** False when this deployment serves models only with workspace keys. */
  platformKeysEnabled: z.boolean(),
  canEdit: z.boolean(),
});
export type ProviderKeysResponse = z.infer<typeof ProviderKeysResponse>;
