import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalDecision, RunRequest, Scopes, type Run } from '@neuroflow/contracts';
import { executionRepo, runsRepo, type RunRow } from '@neuroflow/db';
import { requireScope } from '../auth';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../errors';
import type { RunManager } from '../run-manager';
import { openSse } from '../sse';

const IdParams = z.object({ id: z.string().uuid() });
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).optional() });

/** Public representation (internal columns such as scopes/source are not exposed). */
export function publicRun(run: RunRow): Run {
  const { userId: _u, source: _s, scopes: _sc, ...rest } = run;
  return rest;
}

export async function runRoutes(app: FastifyInstance, deps: AppDeps, runs: RunManager) {
  app.post('/v1/runs', async (req, reply) => {
    const principal = requireScope(req, Scopes.runsWrite);
    const body = RunRequest.parse(req.body);
    const idempotencyKey = headerValue(req.headers['idempotency-key']);
    const result = await runs.create(principal, body, { source: 'api', idempotencyKey });
    return reply.code(result.created ? 201 : 200).send({
      run: publicRun(result.run),
      conversationId: result.conversationId,
      eventsUrl: `/v1/runs/${result.run.id}/events`,
    });
  });

  app.get('/v1/runs/:id', async (req) => {
    const principal = requireScope(req, Scopes.runsRead);
    const { id } = IdParams.parse(req.params);
    const run = await runsRepo.get(deps.pool, id, principal.workspaceId);
    if (!run) throw notFound('Run');
    const details = await executionRepo.runDetails(deps.pool, id);
    return { run: publicRun(run), details };
  });

  app.post('/v1/runs/:id/cancel', async (req) => {
    const principal = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    return { run: publicRun(await runs.cancel(principal, id)) };
  });

  app.post('/v1/runs/:id/approvals', async (req) => {
    const principal = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    const decision = ApprovalDecision.parse(req.body);
    await runs.approve(principal, id, decision.toolCallId, decision.approved, decision.reason);
    return { ok: true };
  });

  /**
   * Realtime execution events over SSE. Supports resume via `Last-Event-ID` (sent automatically
   * by EventSource on reconnect) or `?after=<seq>`. The stream ends after the terminal event.
   */
  app.get('/v1/runs/:id/events', async (req, reply) => {
    const principal = requireScope(req, Scopes.runsRead);
    const { id } = IdParams.parse(req.params);
    const { after } = EventsQuery.parse(req.query);
    const run = await runsRepo.get(deps.pool, id, principal.workspaceId);
    if (!run) throw notFound('Run');
    const lastEventId = Number(headerValue(req.headers['last-event-id']) ?? NaN);
    const afterSeq = Number.isFinite(lastEventId) ? lastEventId : (after ?? 0);

    const sse = openSse(req, reply);
    const stop = await deps.hub.follow(id, afterSeq, (event) => {
      sse.send({ id: event.seq, event: event.type, data: event });
      if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
        setImmediate(() => sse.close());
      }
    });
    sse.onClose(() => void stop());
    if (sse.closed) void stop();
    // A terminal run with nothing left to replay closes immediately.
    const fresh = await runsRepo.get(deps.pool, id);
    if (fresh && fresh.status !== 'queued' && fresh.status !== 'running') {
      setTimeout(() => sse.close(), 50);
    }
  });

  /**
   * Bidirectional run channel for interactive clients: server → events, client → control
   * messages (`{"type":"cancel"}`, `{"type":"approve","toolCallId":"…","approved":true}`).
   */
  app.get('/v1/runs/:id/stream', { websocket: true }, async (socket, req) => {
    let principal;
    try {
      principal = requireScope(req, Scopes.runsRead);
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    const parsed = IdParams.safeParse(req.params);
    const run = parsed.success ? await runsRepo.get(deps.pool, parsed.data.id, principal.workspaceId) : null;
    if (!run) {
      socket.close(4404, 'not found');
      return;
    }
    const stop = await deps.hub.follow(run.id, 0, (event) => socket.send(JSON.stringify(event)));
    socket.on('close', () => void stop());
    socket.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; toolCallId?: string; approved?: boolean; reason?: string };
        if (!principal.scopes.includes(Scopes.runsWrite)) throw new HttpError('forbidden', 'Missing runs:write scope');
        if (msg.type === 'cancel') await runs.cancel(principal, run.id);
        else if (msg.type === 'approve' && msg.toolCallId) {
          await runs.approve(principal, run.id, msg.toolCallId, Boolean(msg.approved), msg.reason);
        } else throw new HttpError('bad_request', 'Unknown control message');
        socket.send(JSON.stringify({ type: 'control.ack', request: msg.type }));
      } catch (err) {
        socket.send(JSON.stringify({ type: 'control.error', message: err instanceof HttpError ? err.message : 'Invalid message' }));
      }
    });
  });
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
