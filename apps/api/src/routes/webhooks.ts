import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateWebhookBody, Scopes, UpdateWebhookBody, WEBHOOK_EVENT_TYPES, type WebhooksResponse } from '@neuroflow/contracts';
import { webhookUrlProblem } from '@neuroflow/bus';
import { webhooksRepo } from '@neuroflow/db';
import { audit } from '../audit';
import { requireScope } from '../auth';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../errors';

const IdParams = z.object({ id: z.string().uuid() });
const DeliveriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

/**
 * Webhooks: endpoints that receive signed run outcomes, approval requests and budget alerts, the
 * workspace's signing secret, and the delivery log. Deliveries are sent by workers.
 */
export async function webhookRoutes(app: FastifyInstance, deps: AppDeps) {
  const policy = { allowPrivate: deps.config.WEBHOOK_ALLOW_PRIVATE };
  const checkUrl = (url: string) => {
    const problem = webhookUrlProblem(url, policy);
    if (problem) throw new HttpError('bad_request', problem);
  };

  app.get('/v1/webhooks', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    return {
      endpoints: await webhooksRepo.list(deps.pool, p.workspaceId),
      secret: await webhooksRepo.secretInfo(deps.pool, p.workspaceId),
      eventTypes: [...WEBHOOK_EVENT_TYPES],
      canEdit: p.scopes.includes(Scopes.admin),
    } satisfies WebhooksResponse;
  });

  app.post('/v1/webhooks', async (req, reply) => {
    const p = requireScope(req, Scopes.admin);
    const body = CreateWebhookBody.parse(req.body);
    checkUrl(body.url);
    await deps.webhooks.ensureSecret(p.workspaceId);
    const endpoint = await webhooksRepo.create(deps.pool, p.workspaceId, body, p.userId);
    void audit(deps, req, { action: 'webhook.created', targetType: 'webhook', targetId: endpoint.id, metadata: { host: new URL(endpoint.url).host, eventTypes: endpoint.eventTypes } });
    return reply.code(201).send({ endpoint });
  });

  app.patch('/v1/webhooks/:id', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = IdParams.parse(req.params);
    const body = UpdateWebhookBody.parse(req.body);
    if (body.url) checkUrl(body.url);
    const endpoint = await webhooksRepo.update(deps.pool, p.workspaceId, id, body);
    if (!endpoint) throw notFound('Webhook');
    void audit(deps, req, { action: 'webhook.updated', targetType: 'webhook', targetId: id, metadata: { fields: Object.keys(body) } });
    return { endpoint };
  });

  app.delete('/v1/webhooks/:id', async (req, reply) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = IdParams.parse(req.params);
    if (!(await webhooksRepo.delete(deps.pool, p.workspaceId, id))) throw notFound('Webhook');
    void audit(deps, req, { action: 'webhook.deleted', targetType: 'webhook', targetId: id });
    return reply.code(204).send();
  });

  app.post('/v1/webhooks/:id/test', async (req, reply) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = IdParams.parse(req.params);
    const deliveryId = await deps.webhooks.test(p.workspaceId, id);
    if (!deliveryId) throw notFound('Webhook');
    return reply.code(202).send({ deliveryId });
  });

  app.get('/v1/webhooks/deliveries', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const { limit } = DeliveriesQuery.parse(req.query);
    return { deliveries: await webhooksRepo.deliveries(deps.pool, p.workspaceId, { limit }) };
  });

  app.get('/v1/webhooks/:id/deliveries', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = IdParams.parse(req.params);
    const { limit } = DeliveriesQuery.parse(req.query);
    if (!(await webhooksRepo.get(deps.pool, p.workspaceId, id))) throw notFound('Webhook');
    return { deliveries: await webhooksRepo.deliveries(deps.pool, p.workspaceId, { endpointId: id, limit }) };
  });

  app.post('/v1/webhooks/deliveries/:id/retry', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = IdParams.parse(req.params);
    const delivery = await webhooksRepo.retry(deps.pool, p.workspaceId, id);
    if (!delivery) throw new HttpError('conflict', 'Only delivered or failed deliveries can be sent again');
    return { delivery };
  });

  // The signing secret is needed to verify deliveries. Admins can read it (audited) and rotate it;
  // after a rotation the previous secret keeps signing for 24 hours.
  app.get('/v1/webhooks/secret', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const secret = await deps.webhooks.ensureSecret(p.workspaceId);
    void audit(deps, req, { action: 'webhook.secret_revealed', targetType: 'workspace', targetId: p.workspaceId });
    return { secret };
  });

  app.post('/v1/webhooks/secret/rotate', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const secret = await deps.webhooks.rotateSecret(p.workspaceId);
    void audit(deps, req, { action: 'webhook.secret_rotated', targetType: 'workspace', targetId: p.workspaceId });
    return { secret, previousValidUntil: new Date(Date.now() + 24 * 3600_000).toISOString() };
  });
}
