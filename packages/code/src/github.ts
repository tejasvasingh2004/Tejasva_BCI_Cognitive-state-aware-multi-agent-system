/**
 * Minimal GitHub REST client used server side only. Tokens never leave this module: they are not
 * logged, not returned, and never placed into model context. `baseUrl` allows GitHub Enterprise and
 * tests.
 */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'auth' | 'forbidden' | 'not_found' | 'validation' | 'rate_limited' | 'unavailable',
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export type GitHubUser = { login: string; id: number; name: string | null; avatarUrl: string; type: string };
export type GitHubOwner = { login: string; type: 'User' | 'Organization'; avatarUrl: string };
export type GitHubRepo = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  description: string | null;
  permissions: { admin: boolean; push: boolean; pull: boolean };
  updatedAt: string;
};
export type GitHubBranch = { name: string; sha: string; protected: boolean };
export type GitHubPull = { number: number; title: string; state: string; htmlUrl: string; head: string; base: string; author: string; draft: boolean };
export type GitHubIssue = { number: number; title: string; state: string; htmlUrl: string; author: string; labels: string[]; body: string | null };

type Raw = Record<string, unknown>;

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
  ) {}

  private get base() {
    return (this.opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, string | number>): Promise<{ data: T; scopes: string[] }> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'NeuroFlow',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GitHubError('GitHub is unreachable', 0, 'unavailable');
    }
    const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (res.status === 204) return { data: undefined as T, scopes };
    const json = (await res.json().catch(() => ({}))) as Raw;
    if (!res.ok) {
      const message = typeof json.message === 'string' ? json.message : `GitHub request failed (${res.status})`;
      const code =
        res.status === 401
          ? 'auth'
          : res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
            ? 'rate_limited'
            : res.status === 403
              ? 'forbidden'
              : res.status === 404
                ? 'not_found'
                : res.status === 422
                  ? 'validation'
                  : res.status === 429
                    ? 'rate_limited'
                    : 'unavailable';
      throw new GitHubError(message, res.status, code);
    }
    return { data: json as T, scopes };
  }

  async getUser(): Promise<{ user: GitHubUser; scopes: string[] }> {
    const { data, scopes } = await this.request<Raw>('GET', '/user');
    return {
      user: { login: String(data.login), id: Number(data.id), name: (data.name as string) ?? null, avatarUrl: String(data.avatar_url ?? ''), type: String(data.type ?? 'User') },
      scopes,
    };
  }

  /** The user plus organizations they belong to (account / organization selection). */
  async listOwners(): Promise<GitHubOwner[]> {
    const { user } = await this.getUser();
    const { data } = await this.request<Raw[]>('GET', '/user/orgs', undefined, { per_page: 100 });
    return [
      { login: user.login, type: 'User', avatarUrl: user.avatarUrl },
      ...data.map((o) => ({ login: String(o.login), type: 'Organization' as const, avatarUrl: String(o.avatar_url ?? '') })),
    ];
  }

  /** Repositories the token can access under an owner (user or organization). */
  async listRepos(owner: string, page = 1): Promise<GitHubRepo[]> {
    const { user } = await this.getUser();
    const { data } =
      owner.toLowerCase() === user.login.toLowerCase()
        ? await this.request<Raw[]>('GET', '/user/repos', undefined, { per_page: 100, page, sort: 'updated', affiliation: 'owner,collaborator' })
        : await this.request<Raw[]>('GET', `/orgs/${encodeURIComponent(owner)}/repos`, undefined, { per_page: 100, page, sort: 'updated' });
    return data.filter((r) => String((r.owner as Raw)?.login ?? '').toLowerCase() === owner.toLowerCase()).map(toRepo);
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepo> {
    return toRepo((await this.request<Raw>('GET', `/repos/${enc(owner)}/${enc(repo)}`)).data);
  }

  async listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
    const { data } = await this.request<Raw[]>('GET', `/repos/${enc(owner)}/${enc(repo)}/branches`, undefined, { per_page: 100 });
    return data.map((b) => ({ name: String(b.name), sha: String((b.commit as Raw)?.sha ?? ''), protected: Boolean(b.protected) }));
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch> {
    const { data } = await this.request<Raw>('GET', `/repos/${enc(owner)}/${enc(repo)}/branches/${encodeURIComponent(branch)}`);
    return { name: String(data.name), sha: String((data.commit as Raw)?.sha ?? ''), protected: Boolean(data.protected) };
  }

  async listPullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubPull[]> {
    const { data } = await this.request<Raw[]>('GET', `/repos/${enc(owner)}/${enc(repo)}/pulls`, undefined, { state, per_page: 30 });
    return data.map(toPull);
  }

  async listIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubIssue[]> {
    const { data } = await this.request<Raw[]>('GET', `/repos/${enc(owner)}/${enc(repo)}/issues`, undefined, { state, per_page: 30 });
    // The issues endpoint also returns pull requests; keep issues only.
    return data.filter((i) => !i.pull_request).map(toIssue);
  }

  async createIssue(owner: string, repo: string, input: { title: string; body?: string; labels?: string[] }): Promise<GitHubIssue> {
    return toIssue((await this.request<Raw>('POST', `/repos/${enc(owner)}/${enc(repo)}/issues`, input)).data);
  }

  async createPullRequest(owner: string, repo: string, input: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<GitHubPull> {
    return toPull((await this.request<Raw>('POST', `/repos/${enc(owner)}/${enc(repo)}/pulls`, input)).data);
  }

  /** Posts a review. NeuroFlow only comments; it never approves or merges on its own. */
  async reviewPullRequest(owner: string, repo: string, pull: number, body: string): Promise<{ id: number; htmlUrl: string }> {
    const { data } = await this.request<Raw>('POST', `/repos/${enc(owner)}/${enc(repo)}/pulls/${pull}/reviews`, { body, event: 'COMMENT' });
    return { id: Number(data.id), htmlUrl: String(data.html_url ?? '') };
  }
}

/** OAuth App web flow: exchanges an authorization code for a user token. */
export async function exchangeOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ token: string; scopes: string[] }> {
  const res = await (input.fetchImpl ?? fetch)(`${(input.baseUrl ?? 'https://github.com').replace(/\/$/, '')}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Raw;
  if (!res.ok || typeof json.access_token !== 'string') {
    throw new GitHubError(String(json.error_description ?? 'GitHub authorization failed'), res.status, 'auth');
  }
  return { token: json.access_token, scopes: String(json.scope ?? '').split(',').filter(Boolean) };
}

const enc = encodeURIComponent;

function toRepo(r: Raw): GitHubRepo {
  const perms = (r.permissions ?? {}) as Raw;
  return {
    id: Number(r.id),
    owner: String((r.owner as Raw)?.login ?? ''),
    name: String(r.name),
    fullName: String(r.full_name),
    private: Boolean(r.private),
    defaultBranch: String(r.default_branch ?? 'main'),
    cloneUrl: String(r.clone_url ?? ''),
    htmlUrl: String(r.html_url ?? ''),
    description: (r.description as string) ?? null,
    permissions: { admin: Boolean(perms.admin), push: Boolean(perms.push), pull: perms.pull === undefined ? true : Boolean(perms.pull) },
    updatedAt: String(r.updated_at ?? ''),
  };
}

function toPull(p: Raw): GitHubPull {
  return {
    number: Number(p.number),
    title: String(p.title),
    state: String(p.state),
    htmlUrl: String(p.html_url ?? ''),
    head: String((p.head as Raw)?.ref ?? ''),
    base: String((p.base as Raw)?.ref ?? ''),
    author: String((p.user as Raw)?.login ?? ''),
    draft: Boolean(p.draft),
  };
}

function toIssue(i: Raw): GitHubIssue {
  return {
    number: Number(i.number),
    title: String(i.title),
    state: String(i.state),
    htmlUrl: String(i.html_url ?? ''),
    author: String((i.user as Raw)?.login ?? ''),
    labels: ((i.labels as Raw[]) ?? []).map((l) => String(l.name)),
    body: ((i.body as string) ?? null)?.slice(0, 4000) ?? null,
  };
}
