import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AuditAction,
  CreateApiKeyBody,
  Scopes,
  UpdateWorkspaceSettingsBody,
  UpsertAgentBody,
  type AgentSpec,
  type WorkspaceUsage,
} from '@neuroflow/contracts';
import { UsageMeter } from '@neuroflow/bus';
import { agentsRepo, auditRepo, authRepo, runsRepo, workspaceRepo } from '@neuroflow/db';
import { BUILTIN_AGENTS } from '@neuroflow/orchestrator';
import { audit } from '../audit';
import { requirePrincipal, requireScope } from '../auth';
import type { AppDeps } from '../deps';
import { forbidden, HttpError, notFound } from '../errors';

const IdParams = z.object({ id: z.string().uuid() });
const AgentParams = z.object({ id: z.string().regex(/^[a-z0-9_-]{2,64}$/) });
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
  action: AuditAction.optional(),
});

const BUILTIN_IDS = new Set(BUILTIN_AGENTS.map((a) => a.id));

/** Built-in agents as read-only specs, for listing next to workspace agents. */
const builtinSpecs = (): AgentSpec[] =>
  BUILTIN_AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    capabilities: a.capabilities ?? [],
    tools: a.tools === '*' ? ['*'] : a.tools,
    modelRole: (['agent', 'research', 'analysis', 'synthesis'].includes(a.modelRole) ? a.modelRole : 'agent') as AgentSpec['modelRole'],
    maxIterations: a.maxIterations,
    builtin: true,
  }));

/** Workspace administration: API keys, settings, custom agents and the audit trail. */
export async function adminRoutes(app: FastifyInstance, deps: AppDeps) {
  // ---- API keys (users manage their own; admins may revoke any key in the workspace) ----
  app.get('/v1/api-keys', async (req) => {
    const p = requirePrincipal(req);
    return { apiKeys: await authRepo.listApiKeys(deps.pool, p.workspaceId, p.userId) };
  });

  app.post('/v1/api-keys', async (req, reply) => {
    const p = requirePrincipal(req);
    // Keys are created from an interactive session (or by an admin key), never key-from-key
    // escalation chains by ordinary keys.
    if (p.via !== 'session' && !p.scopes.includes(Scopes.admin)) throw forbidden('API keys can only be created from a signed-in session');
    const body = CreateApiKeyBody.parse(req.body);
    const requested = body.scopes ?? p.scopes;
    const excess = requested.filter((s) => !p.scopes.includes(s));
    if (excess.length) throw forbidden(`Cannot grant scopes you do not hold: ${excess.join(', ')}`);
    const created = await authRepo.createApiKey(deps.pool, {
      workspaceId: p.workspaceId,
      userId: p.userId,
      name: body.name,
      scopes: requested,
    });
    const info = await authRepo.getApiKeyInfo(deps.pool, created.id);
    void audit(deps, req, { action: 'api_key.created', targetType: 'api_key', targetId: created.id, metadata: { name: body.name, scopes: requested } });
    // The plaintext key is returned exactly once.
    return reply.code(201).send({ apiKey: { ...info!, key: created.key } });
  });

  app.delete('/v1/api-keys/:id', async (req, reply) => {
    const p = requirePrincipal(req);
    const { id } = IdParams.parse(req.params);
    const isAdmin = p.scopes.includes(Scopes.admin);
    if (!(await authRepo.revokeApiKey(deps.pool, p.workspaceId, id, isAdmin ? undefined : p.userId))) throw notFound('API key');
    void audit(deps, req, { action: 'api_key.revoked', targetType: 'api_key', targetId: id });
    return reply.code(204).send();
  });

  // ---- workspace settings ----
  /** Plan, effective limits and today's metered usage of the caller's workspace. */
  app.get('/v1/workspace/usage', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const [{ plan, limits }, tokensToday, activeRuns] = await Promise.all([
      deps.plans.limits(p.workspaceId),
      deps.usage.tokensToday(p.workspaceId),
      runsRepo.countActive(deps.pool, p.workspaceId),
    ]);
    const { queuePriority: _priority, ...publicLimits } = limits;
    return { plan, limits: publicLimits, usage: { tokensToday, activeRuns, resetsAt: UsageMeter.resetsAt().toISOString() } } satisfies WorkspaceUsage;
  });

  app.get('/v1/workspace/settings', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const settings = await workspaceRepo.getSettings(deps.pool, p.workspaceId);
    if (!settings) throw notFound('Workspace');
    return { settings, canEdit: p.scopes.includes(Scopes.admin) };
  });

  app.patch('/v1/workspace/settings', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const patch = UpdateWorkspaceSettingsBody.parse(req.body);
    const settings = await workspaceRepo.updateSettings(deps.pool, p.workspaceId, patch);
    if (!settings) throw notFound('Workspace');
    void audit(deps, req, {
      action: 'workspace.settings_updated',
      targetType: 'workspace',
      targetId: p.workspaceId,
      metadata: { fields: Object.keys(patch), memoryRetentionDays: settings.memoryRetentionDays },
    });
    return { settings, canEdit: true };
  });

  // ---- agents ----
  app.get('/v1/agents', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const custom = await agentsRepo.listForWorkspace(deps.pool, p.workspaceId);
    return { agents: [...builtinSpecs(), ...custom], canEdit: p.scopes.includes(Scopes.admin) };
  });

  app.put('/v1/agents/:id', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = AgentParams.parse(req.params);
    if (BUILTIN_IDS.has(id)) throw new HttpError('conflict', `"${id}" is a built-in agent and cannot be replaced`);
    const body = UpsertAgentBody.parse({ ...(req.body as object), id });
    const unknownTools = body.tools.filter((t) => !deps.tools.names().includes(t));
    if (unknownTools.length) throw new HttpError('bad_request', `Unknown tools: ${unknownTools.join(', ')}`);
    const agent = await agentsRepo.upsert(deps.pool, p.workspaceId, body);
    void audit(deps, req, { action: 'agent.upserted', targetType: 'agent', targetId: id, metadata: { tools: body.tools } });
    return { agent };
  });

  app.delete('/v1/agents/:id', async (req, reply) => {
    const p = requireScope(req, Scopes.admin);
    const { id } = AgentParams.parse(req.params);
    if (!(await agentsRepo.delete(deps.pool, p.workspaceId, id))) throw notFound('Agent');
    void audit(deps, req, { action: 'agent.deleted', targetType: 'agent', targetId: id });
    return reply.code(204).send();
  });

  // ---- audit trail ----
  app.get('/v1/audit', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const q = AuditQuery.parse(req.query);
    return { events: await auditRepo.list(deps.pool, p.workspaceId, q) };
  });
}
