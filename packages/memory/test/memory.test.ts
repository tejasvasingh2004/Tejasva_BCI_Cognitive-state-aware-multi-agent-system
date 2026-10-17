import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_SCOPES } from '@neuroflow/contracts';
import { authRepo, seedDev } from '@neuroflow/db';
import { createTestDatabase, isPostgresReachable } from '@neuroflow/db/testing';
import { ToolRegistry, ToolRuntime } from '@neuroflow/tools';
import { createMemoryTools, PgMemoryService } from '../src';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('memory', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let memory: PgMemoryService;
  let me: { userId: string; workspaceId: string };
  let other: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    memory = new PgMemoryService(db.pool);
    me = await seedDev(db.pool);
    other = await authRepo.ensureUserWithWorkspace(db.pool, { email: 'o@x.io', displayName: 'O', workspaceName: 'O' });
    await memory.store({ ...me, content: 'We decided pricing will be $29 per seat per month', tags: ['pricing'] });
    await memory.store({ ...me, content: 'Preferred deployment region is Mumbai (ap-south-1)' });
    await memory.store({ ...other, content: 'Other workspace pricing secret: $5' });
    for (let i = 0; i < 15; i++) await memory.store({ ...me, content: `Pricing note number ${i}` });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('retrieves relevant memories for natural-language questions', async () => {
    const res = await memory.search({ ...me, query: 'What did I decide about pricing?', limit: 3 });
    expect(res[0]!.content).toContain('$29');
  });

  it('is bounded and scoped to the workspace/user', async () => {
    const res = await memory.search({ ...me, query: 'pricing', limit: 50 });
    expect(res.length).toBeLessThanOrEqual(10);
    expect(res.every((m) => !m.content.includes('$5'))).toBe(true);
  });

  it('runs through the tool runtime with observable memory events', async () => {
    const registry = new ToolRegistry().registerAll(createMemoryTools(memory));
    const events: string[] = [];
    const res = await new ToolRuntime(registry).execute(
      { id: 'm1', name: 'search_memory', arguments: '{"query":"deployment region"}' },
      {
        runId: 'r',
        ...me,
        scopes: [...ALL_SCOPES],
        signal: new AbortController().signal,
        allowedTools: registry.names(),
        emit: (t) => events.push(t),
      },
    );
    expect(res.status).toBe('success');
    expect(JSON.stringify(res.data)).toContain('Mumbai');
    expect(events).toEqual(['tool.started', 'memory.started', 'memory.completed', 'tool.completed']);
  });

  it('denies memory access without the memory scope', async () => {
    const registry = new ToolRegistry().registerAll(createMemoryTools(memory));
    const res = await new ToolRuntime(registry).execute(
      { id: 'm2', name: 'search_memory', arguments: '{"query":"pricing"}' },
      {
        runId: 'r',
        ...me,
        scopes: ['tools:execute'],
        signal: new AbortController().signal,
        allowedTools: registry.names(),
        emit: () => {},
      },
    );
    expect(res.status).toBe('denied');
  });

  it('soft-deletes only own memories', async () => {
    const item = await memory.store({ ...me, content: 'temporary fact' });
    expect(await memory.delete(other, item.id)).toBe(false);
    expect(await memory.delete(me, item.id)).toBe(true);
    expect((await memory.search({ ...me, query: 'temporary fact' })).length).toBe(0);
  });

  it('applies TTLs and the workspace retention policy, then purges expired memories', async () => {
    const scope = await authRepo.ensureUserWithWorkspace(db.pool, { email: 'ret@x.io', displayName: 'R', workspaceName: 'R' });
    const ttl = await memory.store({ ...scope, content: 'Temporary launch code word is pelican', ttlDays: 3 });
    expect(Date.parse(ttl.expiresAt!)).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
    const keep = await memory.store({ ...scope, content: 'Long-lived preference: dark roast coffee' });
    expect(keep.expiresAt).toBeNull();

    // Backdate both, then enable a 7-day workspace retention policy: it applies retroactively.
    await db.pool.query(`UPDATE memories SET created_at = now() - interval '10 days' WHERE workspace_id = $1`, [scope.workspaceId]);
    await db.pool.query(`UPDATE memories SET expires_at = now() - interval '1 second' WHERE id = $1`, [ttl.id]);
    expect((await memory.list(scope)).map((m) => m.id)).toEqual([keep.id]);
    await db.pool.query('UPDATE workspaces SET memory_retention_days = 7 WHERE id = $1', [scope.workspaceId]);
    expect(await memory.list(scope)).toEqual([]);
    expect(await memory.search({ ...scope, query: 'coffee preference' })).toEqual([]);

    const purged = await memory.purgeExpired();
    expect(purged).toContainEqual({ workspaceId: scope.workspaceId, count: 2 });
    expect(await memory.purgeExpired()).not.toContainEqual(expect.objectContaining({ workspaceId: scope.workspaceId }));
    // Other workspaces without retention are untouched.
    expect((await memory.list(me)).length).toBeGreaterThan(0);
  });
});
