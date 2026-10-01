import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectGitHubTokenBody, Scopes } from '@neuroflow/contracts';
import { exchangeOAuthCode, GitHubClient, GitHubError } from '@neuroflow/code';
import { githubRepo, type GitHubConnectionRow } from '@neuroflow/db';
import { audit } from '../audit';
import { requireScope } from '../auth';
import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../errors';

const IdParams = z.object({ id: z.string().uuid() });
const RepoParams = z.object({ id: z.string().uuid(), owner: z.string().min(1).max(100), repo: z.string().min(1).max(100) });
const OAUTH_SCOPES = 'repo read:org';

const publicConnection = (c: GitHubConnectionRow) => ({
  id: c.id,
  kind: c.kind,
  login: c.githubLogin,
  scopes: c.scopes,
  createdAt: c.createdAt,
  lastUsedAt: c.lastUsedAt,
});

/** Maps GitHub API failures onto the NeuroFlow error contract (never leaking tokens). */
export function ghError(err: unknown): never {
  if (err instanceof GitHubError) {
    const code = err.code === 'auth' ? 'unauthorized' : err.code === 'forbidden' ? 'forbidden' : err.code === 'not_found' ? 'not_found' : err.code === 'validation' ? 'bad_request' : 'unavailable';
    throw new HttpError(code, err.code === 'auth' ? 'GitHub rejected the stored credentials. Reconnect GitHub.' : `GitHub: ${err.message}`, undefined, err.code === 'rate_limited' || err.code === 'unavailable');
  }
  throw err;
}

/**
 * GitHub connection flow: Connect (OAuth App or a token) → Authorize → select account/organization
 * → repository → branch. Credentials stay server side, encrypted at rest; connections are personal.
 */
export async function githubRoutes(app: FastifyInstance, deps: AppDeps) {
  const webUrl = (deps.config.PUBLIC_WEB_URL ?? deps.config.CORS_ORIGINS.split(',')[0]!.trim()).replace(/\/$/, '');
  const oauthEnabled = Boolean(deps.config.GITHUB_OAUTH_CLIENT_ID && deps.config.GITHUB_OAUTH_CLIENT_SECRET);
  const redirectUri = `${webUrl}/api/v1/github/oauth/callback`;

  const client = async (principal: { workspaceId: string; userId: string }, connectionId: string) => {
    const conn = await githubRepo.get(deps.pool, connectionId, principal.workspaceId, principal.userId);
    if (!conn) throw notFound('GitHub connection');
    void githubRepo.touch(deps.pool, conn.id).catch(() => {});
    return new GitHubClient(deps.secrets.open(conn.tokenEncrypted), { baseUrl: deps.config.GITHUB_API_URL });
  };

  app.get('/v1/github/config', async (req) => {
    requireScope(req, Scopes.codeRead);
    return { oauth: oauthEnabled, tokenConnect: true, oauthScopes: OAUTH_SCOPES };
  });

  app.get('/v1/github/connections', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    return { connections: (await githubRepo.list(deps.pool, p.workspaceId, p.userId)).map(publicConnection) };
  });

  /** Connect with a personal access token (fine-grained tokens are recommended). */
  app.post('/v1/github/connections', async (req, reply) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { token } = ConnectGitHubTokenBody.parse(req.body);
    const { user, scopes } = await new GitHubClient(token, { baseUrl: deps.config.GITHUB_API_URL }).getUser().catch(ghError);
    const conn = await githubRepo.create(deps.pool, {
      workspaceId: p.workspaceId,
      userId: p.userId,
      kind: 'token',
      githubLogin: user.login,
      githubUserId: user.id,
      tokenEncrypted: deps.secrets.seal(token),
      scopes,
    });
    void audit(deps, req, { action: 'github.connected', targetType: 'github_connection', targetId: conn.id, metadata: { login: user.login, kind: 'token' } });
    return reply.code(201).send({ connection: publicConnection(conn) });
  });

  app.delete('/v1/github/connections/:id', async (req, reply) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    if (!(await githubRepo.revoke(deps.pool, id, p.workspaceId, p.userId))) throw notFound('GitHub connection');
    void audit(deps, req, { action: 'github.disconnected', targetType: 'github_connection', targetId: id });
    return reply.code(204).send();
  });

  // ---- OAuth App web flow ----
  app.get('/v1/github/oauth/start', async (req, reply) => {
    const p = requireScope(req, Scopes.codeWrite);
    if (!oauthEnabled) throw new HttpError('not_found', 'GitHub OAuth is not configured on this server; connect with a token instead');
    const state = randomBytes(24).toString('base64url');
    await deps.redis.set(`nf:ghstate:${state}`, JSON.stringify({ w: p.workspaceId, u: p.userId }), 'EX', 600);
    const url = new URL(`${deps.config.GITHUB_OAUTH_URL.replace(/\/$/, '')}/login/oauth/authorize`);
    url.searchParams.set('client_id', deps.config.GITHUB_OAUTH_CLIENT_ID!);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', OAUTH_SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    return reply.send({ url: url.toString() });
  });

  app.get('/v1/github/oauth/callback', async (req, reply) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { code, state } = z.object({ code: z.string().min(1).max(200), state: z.string().min(10).max(100) }).parse(req.query);
    const raw = await deps.redis.getdel(`nf:ghstate:${state}`);
    const expected = raw ? (JSON.parse(raw) as { w: string; u: string }) : null;
    // The state is single-use and bound to the user that started the flow (CSRF protection).
    if (!expected || expected.w !== p.workspaceId || expected.u !== p.userId) throw new HttpError('bad_request', 'GitHub authorization expired or was started elsewhere. Try again.');
    const { token, scopes } = await exchangeOAuthCode({
      clientId: deps.config.GITHUB_OAUTH_CLIENT_ID!,
      clientSecret: deps.config.GITHUB_OAUTH_CLIENT_SECRET!,
      code,
      redirectUri,
      baseUrl: deps.config.GITHUB_OAUTH_URL,
    }).catch(ghError);
    const { user } = await new GitHubClient(token, { baseUrl: deps.config.GITHUB_API_URL }).getUser().catch(ghError);
    const conn = await githubRepo.create(deps.pool, {
      workspaceId: p.workspaceId,
      userId: p.userId,
      kind: 'oauth',
      githubLogin: user.login,
      githubUserId: user.id,
      tokenEncrypted: deps.secrets.seal(token),
      scopes,
    });
    void audit(deps, req, { action: 'github.connected', targetType: 'github_connection', targetId: conn.id, metadata: { login: user.login, kind: 'oauth' } });
    return reply.redirect(`${webUrl}/code?github=connected`);
  });

  // ---- account / organization → repository → branch selection ----
  app.get('/v1/github/connections/:id/owners', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    return { owners: await (await client(p, id)).listOwners().catch(ghError) };
  });

  app.get('/v1/github/connections/:id/repos', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const { owner, page } = z.object({ owner: z.string().min(1).max(100), page: z.coerce.number().int().min(1).max(50).default(1) }).parse(req.query);
    return { repositories: await (await client(p, id)).listRepos(owner, page).catch(ghError) };
  });

  app.get('/v1/github/connections/:id/repos/:owner/:repo/branches', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id, owner, repo } = RepoParams.parse(req.params);
    return { branches: await (await client(p, id)).listBranches(owner, repo).catch(ghError) };
  });
}
