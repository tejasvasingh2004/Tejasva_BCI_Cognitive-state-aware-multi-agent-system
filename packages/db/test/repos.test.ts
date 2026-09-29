import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { RunRequest } from '@neuroflow/contracts';
import {
  authRepo,
  conversationsRepo,
  executionRepo,
  messagesRepo,
  migrate,
  runEventsRepo,
  runsRepo,
  seedDev,
  withTransaction,
} from '../src';
import { createTestDatabase, isPostgresReachable } from '../src/testing';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('db repositories (Postgres)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;
  let ids: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    ids = await seedDev(pool, { apiKey: 'nf_test_key_123456' });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('migrations are idempotent', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('authenticates hashed API keys and never stores plaintext', async () => {
    const rec = await authRepo.findActiveApiKey(pool, 'nf_test_key_123456');
    expect(rec?.workspaceId).toBe(ids.workspaceId);
    expect(await authRepo.findActiveApiKey(pool, 'nf_wrong')).toBeNull();
    const { rows } = await pool.query('SELECT key_hash FROM api_keys');
    expect(rows.every((r) => r.key_hash !== 'nf_test_key_123456')).toBe(true);
  });

  it('creates runs idempotently and enforces status transitions', async () => {
    const conv = await conversationsRepo.create(pool, ids);
    const request = RunRequest.parse({ messages: [{ role: 'user', content: 'hello' }] });
    const a = await runsRepo.create(pool, { ...ids, conversationId: conv.id, request, source: 'api', scopes: ['runs:write'], idempotencyKey: 'k1' });
    const b = await runsRepo.create(pool, { ...ids, conversationId: conv.id, request, source: 'api', scopes: ['runs:write'], idempotencyKey: 'k1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    expect(a.run.status).toBe('queued');

    const started = await runsRepo.markStarted(pool, a.run.id);
    expect(started?.status).toBe('running');
    expect(started?.attempt).toBe(1);
    expect(await runsRepo.complete(pool, a.run.id, 'done', { promptTokens: 3, completionTokens: 4, totalTokens: 7 })).toBe(true);
    // Terminal runs cannot be completed/failed/cancelled again.
    expect(await runsRepo.fail(pool, a.run.id, { code: 'x', message: 'y' })).toBe(false);
    expect(await runsRepo.markCancelled(pool, a.run.id)).toBe(false);
    const final = await runsRepo.get(pool, a.run.id, ids.workspaceId);
    expect(final?.status).toBe('completed');
    expect(final?.usage?.totalTokens).toBe(7);
  });

  it('isolates runs by workspace', async () => {
    const other = await authRepo.ensureUserWithWorkspace(pool, {
      email: 'other@example.com',
      displayName: 'Other',
      workspaceName: 'Other',
    });
    const conv = await conversationsRepo.create(pool, ids);
    const { run } = await runsRepo.create(pool, {
      ...ids,
      conversationId: conv.id,
      request: RunRequest.parse({ messages: [{ role: 'user', content: 'x' }] }),
      source: 'workspace', scopes: ['runs:write'],
    });
    expect(await runsRepo.get(pool, run.id, other.workspaceId)).toBeNull();
    expect(await conversationsRepo.get(pool, other.workspaceId, conv.id)).toBeNull();
    expect(await runsRepo.requestCancel(pool, run.id, other.workspaceId)).toBeNull();
  });

  it('prevents a cancelled-before-start run from starting', async () => {
    const conv = await conversationsRepo.create(pool, ids);
    const { run } = await runsRepo.create(pool, {
      ...ids,
      conversationId: conv.id,
      request: RunRequest.parse({ messages: [{ role: 'user', content: 'x' }] }),
      source: 'workspace', scopes: ['runs:write'],
    });
    await runsRepo.requestCancel(pool, run.id, ids.workspaceId);
    expect(await runsRepo.markStarted(pool, run.id)).toBeNull();
  });

  it('stores ordered messages and run events', async () => {
    const conv = await withTransaction(pool, async (tx) => {
      const c = await conversationsRepo.create(tx, ids);
      await messagesRepo.append(tx, c.id, [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second', toolCalls: [{ id: 't1', name: 'calculator', arguments: '{}' }] },
      ]);
      return c;
    });
    const msgs = await messagesRepo.listByConversation(pool, conv.id);
    expect(msgs.map((m) => m.content)).toEqual(['first', 'second']);
    expect(msgs[1]!.toolCalls?.[0]?.name).toBe('calculator');

    const { run } = await runsRepo.create(pool, {
      ...ids,
      conversationId: conv.id,
      request: RunRequest.parse({ messages: [{ role: 'user', content: 'x' }] }),
      source: 'workspace', scopes: ['runs:write'],
    });
    const ts = new Date().toISOString();
    await runEventsRepo.append(pool, [
      { runId: run.id, seq: 1, ts, type: 'run.created', data: { mode: 'standard' } },
      { runId: run.id, seq: 2, ts, type: 'response.delta', data: { text: 'hi' } },
    ]);
    // Duplicate seq is ignored (at-least-once publishing is safe).
    await runEventsRepo.append(pool, [{ runId: run.id, seq: 2, ts, type: 'response.delta', data: { text: 'dup' } }]);
    expect((await runEventsRepo.list(pool, run.id)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await runEventsRepo.list(pool, run.id, 1)).map((e) => e.seq)).toEqual([2]);
    expect(await runEventsRepo.maxSeq(pool, run.id)).toBe(2);

    await executionRepo.startToolCall(pool, {
      runId: run.id,
      toolCallId: 'tc1',
      name: 'save_memory',
      arguments: { content: 'x' },
      approvalStatus: 'not_required',
    });
    await executionRepo.finishToolCall(pool, run.id, {
      toolCallId: 'tc1',
      name: 'save_memory',
      status: 'success',
      data: { id: 'm1' },
      durationMs: 5,
      attempts: 1,
      truncated: false,
    });
    expect(await executionRepo.findCompletedToolCall(pool, run.id, 'tc1')).toMatchObject({ data: { id: 'm1' } });
  });
});
