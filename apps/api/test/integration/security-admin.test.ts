import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_SCOPES } from '@neuroflow/contracts';
import { createRedis } from '@neuroflow/bus';
import { authRepo, conversationsRepo, messagesRepo } from '@neuroflow/db';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { defaultScript, textReply, toolCallReply } from '@neuroflow/models/testing';
import { refreshSummary } from '@neuroflow/worker';
import { api, readSse, runEvents, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();
const PASSWORD = 'correct-horse-battery-staple';

describe.skipIf(!reachable)('security, administration and OpenAI tools', () => {
  let h: Harness;
  let workspaceId: string;
  let member: { userId: string; key: string };
  let viewer: { userId: string; key: string };

  /** Signs in with email/password and returns the session cookie header. */
  async function login(email: string, password = PASSWORD) {
    const res = await api(h, '/v1/auth/login', { method: 'POST', key: null, json: { email, password } });
    return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }

  async function clearAuthFailures() {
    const r = createRedis(h.redisUrl);
    await r.del('nf:authfail:127.0.0.1');
    r.disconnect();
  }

  async function addMember(email: string, role: 'member' | 'viewer') {
    const ids = await authRepo.ensureUserWithWorkspace(h.db.pool, { email, displayName: email, workspaceName: email });
    await h.db.pool.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspaceId, ids.userId, role]);
    await authRepo.setPassword(h.db.pool, ids.userId, PASSWORD);
    const { key } = await authRepo.createApiKey(h.db.pool, { workspaceId, userId: ids.userId, name: 'test', scopes: [...ALL_SCOPES] });
    return { userId: ids.userId, key };
  }

  beforeAll(async () => {
    h = await startHarness({ AUTH_FAILURE_LIMIT: '5' });
    workspaceId = (await (await api(h, '/v1/me')).json()).workspace.id;
    member = await addMember('member@x.io', 'member');
    viewer = await addMember('viewer@x.io', 'viewer');
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    h.qwen.setScript(defaultScript);
    await clearAuthFailures();
  });

  describe('authentication', () => {
    it('signs in with email/password, records the login and rejects bad passwords', async () => {
      const ok = await login('member@x.io');
      expect(ok.res.status).toBe(200);
      const me = await api(h, '/v1/me', { key: null, headers: { cookie: ok.cookie } });
      expect((await me.json()).user.email).toBe('member@x.io');

      const bad = await login('member@x.io', 'wrong password!!');
      expect(bad.res.status).toBe(401);
      expect((await bad.res.json()).error.message).toBe('Incorrect email or password');
      // Unknown accounts fail identically (no account enumeration).
      const unknown = await login('nobody@x.io');
      expect((await unknown.res.json()).error.message).toBe('Incorrect email or password');

      // Failed logins have no authenticated workspace; they are recorded with the attempted email only.
      const { rows } = await h.db.pool.query(
        `SELECT action, metadata FROM audit_events WHERE action IN ('auth.login', 'auth.login_failed') ORDER BY created_at`,
      );
      expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.login', 'auth.login_failed']));
      expect(JSON.stringify(rows)).not.toContain('wrong password');
    });

    it('throttles repeated failures per client before checking credentials', async () => {
      for (let i = 0; i < 5; i++) expect((await api(h, '/v1/conversations', { key: `nf_bogus_${i}` })).status).toBe(401);
      const blocked = await api(h, '/v1/conversations', { key: 'nf_bogus_again' });
      expect(blocked.status).toBe(429);
      expect((await login('member@x.io')).res.status).toBe(429);
      await clearAuthFailures();
      expect((await login('member@x.io')).res.status).toBe(200);
    });

    it('API keys never exceed the owner\'s current role and die with their membership', async () => {
      // The viewer's key was issued with every scope, but the viewer role only allows reading.
      expect((await api(h, '/v1/conversations', { key: viewer.key })).status).toBe(200);
      const denied = await api(h, '/v1/runs', { key: viewer.key, method: 'POST', json: { messages: [{ role: 'user', content: 'hi' }] } });
      expect(denied.status).toBe(403);
      expect((await denied.json()).error.code).toBe('forbidden');

      const temp = await addMember('leaver@x.io', 'member');
      expect((await api(h, '/v1/conversations', { key: temp.key })).status).toBe(200);
      await h.db.pool.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, temp.userId]);
      expect((await api(h, '/v1/conversations', { key: temp.key })).status).toBe(401);
    });
  });

  describe('API key management', () => {
    it('creates keys from a session (shown once), narrows scopes, revokes', async () => {
      const { cookie } = await login('member@x.io');
      // Member sessions land in their own workspace; create a key there.
      const created = await api(h, '/v1/api-keys', {
        method: 'POST',
        key: null,
        headers: { cookie },
        json: { name: 'ci', scopes: ['runs:read'] },
      });
      expect(created.status).toBe(201);
      const { apiKey } = await created.json();
      expect(apiKey.key).toMatch(/^nf_/);
      expect(apiKey.scopes).toEqual(['runs:read']);

      const list = await (await api(h, '/v1/api-keys', { key: null, headers: { cookie } })).json();
      expect(list.apiKeys[0]).not.toHaveProperty('key');
      expect((await api(h, '/v1/conversations', { key: apiKey.key })).status).toBe(200);
      expect((await api(h, '/v1/memories', { key: apiKey.key })).status).toBe(403);

      // A user whose only membership is "member" cannot grant scopes they do not hold.
      const { rows } = await h.db.pool.query(`INSERT INTO users (email, display_name) VALUES ('plain@x.io', 'Plain') RETURNING id`);
      await h.db.pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, rows[0].id]);
      await authRepo.setPassword(h.db.pool, rows[0].id, PASSWORD);
      const plain = await login('plain@x.io');
      const escalate = await api(h, '/v1/api-keys', { method: 'POST', key: null, headers: { cookie: plain.cookie }, json: { name: 'x', scopes: ['admin'] } });
      expect(escalate.status).toBe(403);
      // Ordinary (non-admin) keys cannot mint more keys.
      expect((await api(h, '/v1/api-keys', { method: 'POST', key: member.key, json: { name: 'chain' } })).status).toBe(403);

      expect((await api(h, `/v1/api-keys/${apiKey.id}`, { method: 'DELETE', key: null, headers: { cookie } })).status).toBe(204);
      expect((await api(h, '/v1/conversations', { key: apiKey.key })).status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('only the run owner may approve its actions', async () => {
      const { run } = await (
        await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'please be slow' }], agentStrategy: 'direct' } })
      ).json();
      // Wait until it is running.
      for (let i = 0; i < 50; i++) {
        const s = (await (await api(h, `/v1/runs/${run.id}`)).json()).run.status;
        if (s === 'running') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const res = await api(h, `/v1/runs/${run.id}/approvals`, {
        method: 'POST',
        key: member.key,
        json: { toolCallId: 'x', approved: true },
      });
      expect(res.status).toBe(403);
      await api(h, `/v1/runs/${run.id}/cancel`, { method: 'POST' });
      await runEvents(h, run.id);
    });

    it('workspace settings, agents and the audit log require admin', async () => {
      expect((await api(h, '/v1/workspace/settings', { key: member.key })).status).toBe(200);
      expect((await api(h, '/v1/workspace/settings', { key: member.key, method: 'PATCH', json: { instructions: 'x' } })).status).toBe(403);
      expect((await api(h, '/v1/agents/my-agent', { key: member.key, method: 'PUT', json: {} })).status).toBe(403);
      expect((await api(h, '/v1/audit', { key: member.key })).status).toBe(403);
    });
  });

  describe('workspace settings, agents, summaries', () => {
    it('workspace instructions reach the model; retention hides old memories', async () => {
      const patched = await api(h, '/v1/workspace/settings', {
        method: 'PATCH',
        json: { instructions: 'Answers must mention the codename ORCHID.', memoryRetentionDays: 30 },
      });
      expect((await patched.json()).settings).toEqual({ instructions: 'Answers must mention the codename ORCHID.', memoryRetentionDays: 30 });

      h.qwen.requests.length = 0;
      const { run } = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'hello' }] } })).json();
      await runEvents(h, run.id);
      expect(h.qwen.requests[0]!.messages[0]!.content).toContain('ORCHID');

      const { memory } = await (await api(h, '/v1/memories', { method: 'POST', json: { content: 'Old decision about vendors' } })).json();
      expect(memory.expiresAt).not.toBeNull();
      await h.db.pool.query(`UPDATE memories SET created_at = now() - interval '40 days' WHERE id = $1`, [memory.id]);
      const list = await (await api(h, '/v1/memories')).json();
      expect(list.memories.map((m: { id: string }) => m.id)).not.toContain(memory.id);

      await api(h, '/v1/workspace/settings', { method: 'PATCH', json: { instructions: '', memoryRetentionDays: null } });
    });

    it('manages custom agents and runs one by name', async () => {
      expect((await api(h, '/v1/agents/assistant', { method: 'PUT', json: {} })).status).toBe(409);
      const bad = await api(h, '/v1/agents/reviewer', {
        method: 'PUT',
        json: { name: 'Reviewer', description: 'Reviews code', instructions: 'Review.', tools: ['shell'] },
      });
      expect(bad.status).toBe(400);
      const put = await api(h, '/v1/agents/reviewer', {
        method: 'PUT',
        json: {
          name: 'Reviewer',
          description: 'Reviews code for bugs',
          instructions: 'You are a meticulous code reviewer.',
          capabilities: ['code review'],
          tools: ['calculator'],
          outputContract: { format: 'markdown', description: 'Use a bullet list of findings.' },
        },
      });
      expect(put.status).toBe(200);
      const agents = (await (await api(h, '/v1/agents')).json()).agents as Array<{ id: string; builtin?: boolean }>;
      expect(agents.find((a) => a.id === 'reviewer')?.builtin).toBeUndefined();
      expect(agents.find((a) => a.id === 'assistant')?.builtin).toBe(true);

      h.qwen.requests.length = 0;
      const { run } = await (
        await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'Review my diff' }], agent: 'reviewer' } })
      ).json();
      const events = await runEvents(h, run.id);
      expect(events.at(-1)!.type).toBe('run.completed');
      const detail = await (await api(h, `/v1/runs/${run.id}`)).json();
      expect(detail.details.agents[0].agentId).toBe('reviewer');
      expect(h.qwen.requests[0]!.messages[0]!.content).toContain('meticulous code reviewer');

      expect((await api(h, '/v1/agents/reviewer', { method: 'DELETE' })).status).toBe(204);
      const audit = (await (await api(h, '/v1/audit?action=agent.upserted')).json()).events;
      expect(audit[0]).toMatchObject({ action: 'agent.upserted', targetId: 'reviewer' });
    });

    it('summarises long conversations and includes the summary in later runs', async () => {
      const conv = await conversationsRepo.create(h.db.pool, { workspaceId, userId: (await (await api(h, '/v1/me')).json()).user.id });
      const seed = Array.from({ length: 26 }, (_, i) => ({
        role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
        content: i === 0 ? 'Our launch is planned for May.' : `message ${i}`,
      }));
      await messagesRepo.append(h.db.pool, conv.id, seed);
      h.qwen.setScript(() => textReply('- The user plans a launch in May.'));
      expect(await refreshSummary({ pool: h.db.pool, runtime: h.runtime }, conv.id, null)).toBe(true);
      const stored = await conversationsRepo.getSummary(h.db.pool, conv.id);
      expect(stored.summary).toBe('- The user plans a launch in May.');

      h.qwen.setScript(defaultScript);
      h.qwen.requests.length = 0;
      const res = await api(h, `/v1/conversations/${conv.id}/runs`, { method: 'POST', json: { messages: [{ role: 'user', content: 'When is the launch?' }] } });
      await runEvents(h, (await res.json()).run.id);
      const sent = h.qwen.requests[0]!.messages;
      expect(sent[0]!.content).toContain('The user plans a launch in May.');
      // Summarised messages are not repeated verbatim.
      expect(sent.some((m) => m.content === 'Our launch is planned for May.')).toBe(false);
    });
  });

  describe('OpenAI-compatible client tools and response formats', () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
      },
    ];

    it('returns tool calls to the client and continues from tool results', async () => {
      h.qwen.setScript((body) =>
        body.messages.some((m) => m.role === 'tool') ? textReply('It is sunny in Pune.') : toolCallReply('get_weather', { city: 'Pune' }, 'call_1'),
      );
      const first = await (
        await api(h, '/v1/chat/completions', { method: 'POST', json: { model: 'neuroflow-auto', messages: [{ role: 'user', content: 'Weather in Pune?' }], tools } })
      ).json();
      expect(first.choices[0]).toMatchObject({
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Pune"}' } }] },
      });

      const second = await (
        await api(h, '/v1/chat/completions', {
          method: 'POST',
          json: {
            model: 'neuroflow-auto',
            tools,
            messages: [
              { role: 'user', content: 'Weather in Pune?' },
              first.choices[0].message,
              { role: 'tool', tool_call_id: 'call_1', content: '{"forecast":"sunny"}' },
            ],
          },
        })
      ).json();
      expect(second.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: 'It is sunny in Pune.' } });

      h.qwen.setScript(() => toolCallReply('get_weather', { city: 'Goa' }, 'call_2'));
      const stream = await api(h, '/v1/chat/completions', {
        method: 'POST',
        json: { model: 'neuroflow-auto', stream: true, tools, messages: [{ role: 'user', content: 'Weather in Goa?' }] },
      });
      const frames = (await readSse(stream)).filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));
      const toolChunk = frames.find((f) => f.choices?.[0]?.delta?.tool_calls);
      expect(toolChunk.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 'call_2', function: { name: 'get_weather' } });
      expect(frames.some((f) => f.choices?.[0]?.finish_reason === 'tool_calls')).toBe(true);
    });

    it('honours response_format json_schema end to end', async () => {
      h.qwen.setScript(() => textReply('{"city":"Pune","temp":31}'));
      h.qwen.requests.length = 0;
      const res = await (
        await api(h, '/v1/chat/completions', {
          method: 'POST',
          json: {
            model: 'neuroflow-auto',
            messages: [{ role: 'user', content: 'Give weather as JSON' }],
            response_format: { type: 'json_schema', json_schema: { name: 'w', schema: { type: 'object', required: ['city'] } } },
          },
        })
      ).json();
      expect(JSON.parse(res.choices[0].message.content)).toEqual({ city: 'Pune', temp: 31 });
      expect(h.qwen.requests[0]!.response_format).toBeDefined();
    });
  });
});
