import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateConversationBody,
  CreateMemoryBody,
  RunRequest,
  Scopes,
  SearchMemoryBody,
  SetCognitiveStateBody,
  UpdateConversationBody,
} from '@neuroflow/contracts';
import { derivePolicy } from '@neuroflow/cognitive';
import { cognitiveRepo, conversationsRepo, messagesRepo, runsRepo } from '@neuroflow/db';
import { audit } from '../audit';
import { requireScope } from '../auth';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../errors';
import type { RunManager } from '../run-manager';
import { publicRun } from './runs';

const IdParams = z.object({ id: z.string().uuid() });

/** Routes backing the React workspace: conversations, memories, models, tools, cognitive state. */
export async function workspaceRoutes(app: FastifyInstance, deps: AppDeps, runs: RunManager) {
  // ---- conversations ----
  app.get('/v1/conversations', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    return { conversations: await conversationsRepo.list(deps.pool, p.workspaceId) };
  });

  app.post('/v1/conversations', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const body = CreateConversationBody.parse(req.body ?? {});
    return reply.code(201).send({ conversation: await conversationsRepo.create(deps.pool, { ...p, title: body.title }) });
  });

  app.get('/v1/conversations/:id', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const { id } = IdParams.parse(req.params);
    const conversation = await conversationsRepo.get(deps.pool, p.workspaceId, id);
    if (!conversation) throw notFound('Conversation');
    const [messages, runList] = await Promise.all([
      messagesRepo.listByConversation(deps.pool, id),
      runsRepo.listByConversation(deps.pool, id),
    ]);
    return { conversation, messages, runs: runList.map(publicRun) };
  });

  app.patch('/v1/conversations/:id', async (req) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    const { title } = UpdateConversationBody.parse(req.body);
    const conversation = await conversationsRepo.rename(deps.pool, p.workspaceId, id, title);
    if (!conversation) throw notFound('Conversation');
    return { conversation };
  });

  app.delete('/v1/conversations/:id', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    if (!(await conversationsRepo.archive(deps.pool, p.workspaceId, id))) throw notFound('Conversation');
    return reply.code(204).send();
  });

  /** Workspace composer entry point: appends the user message and starts a run. */
  app.post('/v1/conversations/:id/runs', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    const body = RunRequest.parse({ ...(req.body as object), conversationId: id });
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const result = await runs.create(p, body, { source: 'workspace', idempotencyKey });
    return reply.code(result.created ? 201 : 200).send({
      run: publicRun(result.run),
      conversationId: result.conversationId,
      eventsUrl: `/v1/runs/${result.run.id}/events`,
    });
  });

  // ---- memories ----
  app.get('/v1/memories', async (req) => {
    const p = requireScope(req, Scopes.memoryRead);
    return { memories: await deps.memory.list(p) };
  });

  app.post('/v1/memories', async (req, reply) => {
    const p = requireScope(req, Scopes.memoryWrite);
    const body = CreateMemoryBody.parse(req.body);
    const memory = await deps.memory.store({ ...p, ...body, source: 'user' });
    void audit(deps, req, { action: 'memory.created', targetType: 'memory', targetId: memory.id, metadata: { tags: body.tags } });
    return reply.code(201).send({ memory });
  });

  app.post('/v1/memories/search', async (req) => {
    const p = requireScope(req, Scopes.memoryRead);
    const body = SearchMemoryBody.parse(req.body);
    return { memories: await deps.memory.search({ ...p, ...body }) };
  });

  app.delete('/v1/memories/:id', async (req, reply) => {
    const p = requireScope(req, Scopes.memoryWrite);
    const { id } = IdParams.parse(req.params);
    if (!(await deps.memory.delete(p, id))) throw notFound('Memory');
    void audit(deps, req, { action: 'memory.deleted', targetType: 'memory', targetId: id });
    return reply.code(204).send();
  });

  // ---- tools ----
  app.get('/v1/tools', async (req) => {
    requireScope(req, Scopes.runsRead);
    return { tools: deps.tools.describe() };
  });

  // ---- cognitive state (Cognitive Mode only; never consulted in Standard Mode) ----
  app.get('/v1/cognitive/state', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const state = await cognitiveRepo.get(deps.pool, p.workspaceId, p.userId);
    return {
      state,
      policy: state ? derivePolicy(state) : null,
      bciAvailable: Boolean(deps.bci),
    };
  });

  app.put('/v1/cognitive/state', async (req) => {
    const p = requireScope(req, Scopes.runsWrite);
    const body = SetCognitiveStateBody.parse(req.body);
    const state = { ...body, observedAt: new Date().toISOString() };
    await cognitiveRepo.upsert(deps.pool, p.workspaceId, p.userId, body.source === 'manual' ? 'manual' : body.source, state);
    void audit(deps, req, { action: 'cognitive.state_set', metadata: { workload: body.workload, source: body.source } });
    return { state, policy: derivePolicy(state) };
  });

  /** Samples the EEG workload classifier service and stores the result. */
  app.post('/v1/cognitive/sample', async (req) => {
    const p = requireScope(req, Scopes.runsWrite);
    if (!deps.bci) throw new HttpError('unavailable', 'No BCI service is configured (set BCI_SERVICE_URL)');
    let state;
    try {
      state = await deps.bci.getState(p);
    } catch {
      throw new HttpError('unavailable', 'The BCI service is not reachable', undefined, true);
    }
    if (!state) throw new HttpError('unavailable', 'The BCI service returned no state', undefined, true);
    await cognitiveRepo.upsert(deps.pool, p.workspaceId, p.userId, 'bci', state);
    return { state, policy: derivePolicy(state) };
  });
}
