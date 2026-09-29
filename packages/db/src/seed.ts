import { ALL_SCOPES } from '@neuroflow/contracts';
import type { Queryable } from './client';
import { authRepo } from './auth';

export const DEV_USER = {
  email: 'dev@neuroflow.local',
  displayName: 'Developer',
  workspaceName: 'Personal workspace',
};

/**
 * Ensures the development principal exists. When `apiKey` is given it is registered (hashed) so
 * programmatic clients can authenticate locally. Never used when AUTH_MODE=production.
 */
export async function seedDev(db: Queryable, opts: { apiKey?: string } = {}) {
  const ids = await authRepo.ensureUserWithWorkspace(db, DEV_USER);
  if (opts.apiKey) {
    await authRepo.createApiKey(db, {
      ...ids,
      name: 'Development key',
      scopes: [...ALL_SCOPES],
      key: opts.apiKey,
    });
  }
  return ids;
}
