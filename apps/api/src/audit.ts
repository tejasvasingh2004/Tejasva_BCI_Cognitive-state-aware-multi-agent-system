import type { FastifyRequest } from 'fastify';
import { auditRepo, type AuditInput } from '@neuroflow/db';
import type { AppDeps } from './deps';

/**
 * Records a security-relevant action. Audit writes are best effort: a failure is logged but never
 * fails the user's request. Callers must not pass secrets or message content in metadata.
 */
export function audit(deps: Pick<AppDeps, 'pool' | 'logger'>, req: FastifyRequest | null, input: AuditInput): Promise<void> {
  const p = req?.principal;
  return auditRepo
    .record(deps.pool, {
      workspaceId: p?.workspaceId ?? null,
      actorUserId: p?.userId ?? null,
      actorVia: p ? (p.via === 'api_key' ? `api_key:${p.apiKeyId ?? ''}` : 'session') : null,
      ip: req?.ip ?? null,
      ...input,
    })
    .catch((err) => deps.logger.error({ err, action: input.action }, 'failed to write audit event'));
}
