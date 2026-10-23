import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateProviderKeyBody, Scopes, UpdateProviderKeyBody, type ProviderKeyInfo, type ProviderKeysResponse } from '@neuroflow/contracts';
import { DuplicateProviderKeyError } from '@neuroflow/db';
import { audit } from '../audit';
import { requireScope } from '../auth';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../errors';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * Bring-your-own-key: a workspace's own model provider keys. Keys are write-only — checked against
 * the provider before they are stored, encrypted (envelope encryption), and afterwards shown only
 * as a 4-character hint. Runs then call that provider with the workspace's key.
 */
export async function providerKeyRoutes(app: FastifyInstance, deps: AppDeps) {
  const platformKeysEnabled = deps.config.PLATFORM_MODEL_KEYS === 'enabled';
  const providerName = (id: string) => deps.gateway.credentialProviders().find((p) => p.id === id)?.displayName ?? id;

  /** Checks a key with the provider; a key the provider could not be asked about is not judged. */
  const check = async (provider: string, apiKey: string) => {
    const result = await deps.gateway.verifyCredential(provider, apiKey, AbortSignal.timeout(10_000));
    if (!result.ok && result.reason === 'unreachable') {
      throw new HttpError('unavailable', `Could not reach ${providerName(provider)} to check this key. Try again shortly.`, undefined, true);
    }
    return result;
  };

  /** Adds this month's spend to each key (from the counters workers charge). */
  const withSpend = (keys: ProviderKeyInfo[]) =>
    Promise.all(keys.map(async (k) => ({ ...k, spendThisMonthUsd: Math.round((await deps.budgets.spend({ scope: 'key_month', keyId: k.id })) * 1e4) / 1e4 })));

  app.get('/v1/provider-keys', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    return {
      providers: deps.gateway.credentialProviders(),
      keys: await withSpend(await deps.providerKeys.list(p.workspaceId)),
      platformKeysEnabled,
      canEdit: p.scopes.includes(Scopes.admin),
    } satisfies ProviderKeysResponse;
  });

  app.post('/v1/provider-keys', async (req, reply) => {
    const p = requireScope(req, Scopes.admin);
    const body = CreateProviderKeyBody.parse(req.body);
    if (!deps.gateway.credentialProviders().some((x) => x.id === body.provider)) {
      throw new HttpError('bad_request', `${body.provider} does not accept workspace keys`);
    }
    const result = await check(body.provider, body.apiKey);
    if (!result.ok) {
      void audit(deps, req, { action: 'provider_key.created', outcome: 'failure', targetType: 'provider', targetId: body.provider, metadata: { reason: 'rejected' } });
      throw new HttpError('bad_request', `${providerName(body.provider)} rejected this key. Check that it is complete and active.`);
    }
    try {
      const key = await deps.providerKeys.create({ workspaceId: p.workspaceId, userId: p.userId, provider: body.provider, apiKey: body.apiKey, ...(body.label ? { label: body.label } : {}) });
      deps.gateways.invalidate(p.workspaceId);
      void audit(deps, req, { action: 'provider_key.created', targetType: 'provider_key', targetId: key.id, metadata: { provider: key.provider, hint: key.hint } });
      return reply.code(201).send({ key });
    } catch (err) {
      if (err instanceof DuplicateProviderKeyError) throw new HttpError('conflict', err.message);
      throw err;
    }
  });

  app.post('/v1/provider-keys/:id/verify', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = IdParams.parse(req.params);
    const stored = await deps.providerKeys.reveal(p.workspaceId, id);
    if (!stored) throw notFound('Provider key');
    const result = await check(stored.provider, stored.apiKey);
    const key = await deps.providerKeys.setStatus(p.workspaceId, id, result.ok ? { ok: true } : { ok: false, message: result.message });
    deps.gateways.invalidate(p.workspaceId);
    void audit(deps, req, { action: 'provider_key.verified', outcome: result.ok ? 'success' : 'failure', targetType: 'provider_key', targetId: id, metadata: { provider: stored.provider } });
    return { key };
  });

  // Rename a key or set its monthly budget. A key over budget is skipped for its provider (the run
  // falls back to other models) rather than replaced by a platform key.
  app.patch('/v1/provider-keys/:id', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = IdParams.parse(req.params);
    const body = UpdateProviderKeyBody.parse(req.body);
    const key = await deps.providerKeys.update(p.workspaceId, id, body);
    if (!key) throw notFound('Provider key');
    deps.budgets.invalidate(p.workspaceId);
    void audit(deps, req, { action: 'provider_key.updated', targetType: 'provider_key', targetId: id, metadata: { provider: key.provider, ...body } });
    return { key: (await withSpend([key]))[0] };
  });

  app.delete('/v1/provider-keys/:id', async (req, reply) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = IdParams.parse(req.params);
    const key = await deps.providerKeys.delete(p.workspaceId, id);
    if (!key) throw notFound('Provider key');
    deps.gateways.invalidate(p.workspaceId);
    void audit(deps, req, { action: 'provider_key.deleted', targetType: 'provider_key', targetId: id, metadata: { provider: key.provider, hint: key.hint } });
    return reply.code(204).send();
  });
}
