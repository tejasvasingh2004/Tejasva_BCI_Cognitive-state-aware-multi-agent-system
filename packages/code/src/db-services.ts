import { mkdir, rm } from 'node:fs/promises';
import type { CodeWorkspace } from '@neuroflow/contracts';
import { publishWorkspaceEvent, type Redis } from '@neuroflow/bus';
import {
  codeRunsRepo,
  codeWorkspacesRepo,
  githubRepo,
  gitOpsRepo,
  patchesRepo,
  sandboxRepo,
  type CodeWorkspaceRow,
  type Queryable,
} from '@neuroflow/db';
import { Git, type GitAuth } from './git';
import { GitHubClient } from './github';
import { summarizePatch } from './patch';
import type { Sandbox } from './sandbox';
import type { SecretBox } from './secrets';
import type { CodeServices, CodeStore, OpenCodeWorkspace } from './services';
import { AGENT_BRANCH_PREFIX, agentBranchName } from './tools/git';
import { RepoCheckout } from './workspace';

export type CodeEnv = {
  pool: Queryable;
  /** Root directory for checkouts and sandbox caches (never served to the web). */
  dataDir: string;
  secrets: SecretBox;
  sandbox: Sandbox;
  redis?: Redis;
  githubApiUrl?: string;
  /** Identity used for commits made by NeuroFlow. */
  author?: { name: string; email: string };
};

const DEFAULT_AUTHOR = { name: 'NeuroFlow Agent', email: 'agent@neuroflow.local' };

/** Public shape of a code workspace (no internal ids / credentials). */
export function publicCodeWorkspace(row: CodeWorkspaceRow): CodeWorkspace {
  const { workspaceId: _w, createdBy: _c, commands: _cmd, repository, ...rest } = row;
  const { workspaceId: _rw, connectionId: _cid, cloneUrl: _url, ...repo } = repository;
  return { ...rest, repository: repo };
}

export class CodeWorkspaceService {
  private readonly checkouts = new Map<string, RepoCheckout>();

  constructor(readonly env: CodeEnv) {}

  checkout(id: string): RepoCheckout {
    let c = this.checkouts.get(id);
    if (!c) {
      const p = RepoCheckout.paths(this.env.dataDir, id);
      c = new RepoCheckout(p.root, p.cacheDir, this.env.author ?? DEFAULT_AUTHOR);
      this.checkouts.set(id, c);
    }
    return c;
  }

  async row(id: string, workspaceId: string): Promise<CodeWorkspaceRow> {
    const row = await codeWorkspacesRepo.get(this.env.pool, id, workspaceId);
    if (!row || row.status === 'archived') throw new CodeWorkspaceNotFound();
    return row;
  }

  async token(row: CodeWorkspaceRow): Promise<string | null> {
    if (row.repository.provider !== 'github' || !row.repository.connectionId) return null;
    const conn = await githubRepo.getById(this.env.pool, row.repository.connectionId, row.workspaceId);
    if (!conn) return null;
    void githubRepo.touch(this.env.pool, conn.id).catch(() => {});
    return this.env.secrets.open(conn.tokenEncrypted);
  }

  async gitAuth(row: CodeWorkspaceRow): Promise<GitAuth | undefined> {
    const token = await this.token(row);
    return token ? { token } : undefined;
  }

  async github(row: CodeWorkspaceRow): Promise<GitHubClient | null> {
    const token = await this.token(row);
    return token ? new GitHubClient(token, { baseUrl: this.env.githubApiUrl }) : null;
  }

  async publish(id: string, type: string, data: unknown) {
    if (this.env.redis) await publishWorkspaceEvent(this.env.redis, id, type, data).catch(() => {});
  }

  /** Clones (first time) or fetches and fast-forwards a clean checkout. Runs in the worker. */
  async sync(id: string, workspaceId: string): Promise<void> {
    const row = await this.row(id, workspaceId);
    const checkout = this.checkout(id);
    await codeWorkspacesRepo.setStatus(this.env.pool, id, (await checkout.exists()) ? 'syncing' : 'provisioning');
    await this.publish(id, 'workspace.status', { status: 'syncing' });
    try {
      const auth = await this.gitAuth(row);
      if (!(await checkout.exists())) {
        await rm(RepoCheckout.paths(this.env.dataDir, id).dir, { recursive: true, force: true });
        await Git.clone(row.repository.cloneUrl, checkout.root, { branch: row.baseBranch, auth });
        await mkdir(checkout.cacheDir, { recursive: true });
      } else {
        await checkout.git.fetch(auth);
        const [status, branch] = await Promise.all([checkout.git.status(), checkout.git.currentBranch()]);
        // Only fast-forward a clean checkout of the base branch; never touch local work.
        if (status.length === 0 && branch === row.baseBranch) {
          await checkout.git.run(['merge', '--ff-only', `origin/${row.baseBranch}`], { allowFail: true });
        }
      }
      const [head, branch, { profile }] = await Promise.all([checkout.git.head(), checkout.git.currentBranch(), checkout.understand()]);
      const commands = Object.fromEntries(Object.entries(profile.commands).filter(([, v]) => v)) as Record<string, string>;
      await codeWorkspacesRepo.markSynced(this.env.pool, id, { headCommit: head, branch, commands: { ...commands, ...row.commands } });
      await this.publish(id, 'workspace.status', { status: 'ready', head, branch });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : 'Synchronization failed';
      await codeWorkspacesRepo.setStatus(this.env.pool, id, 'error', message);
      await this.publish(id, 'workspace.status', { status: 'error', error: message });
      throw err;
    }
  }

  async diffSummary(id: string) {
    const diff = await this.checkout(id).git.diff();
    const files = summarizePatch(diff);
    return { diff, files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) };
  }

  /** User-initiated commit (from the Git panel). Commits on an agent branch, never the base branch. */
  async commit(id: string, workspaceId: string, input: { message: string; userId: string; runId?: string | null }) {
    const row = await this.row(id, workspaceId);
    const git = this.checkout(id).git;
    let branch = await git.currentBranch();
    if (branch === row.baseBranch) {
      branch = agentBranchName(input.message.split('\n')[0]!);
      const existing = await git.branches();
      if (existing.includes(branch)) await git.checkout(branch);
      else {
        await git.createBranch(branch);
        await gitOpsRepo.record(this.env.pool, { workspaceId, codeWorkspaceId: id, runId: input.runId ?? null, kind: 'branch', ref: branch, performedBy: input.userId });
      }
    }
    const files = (await git.status()).length;
    const sha = await git.commitAll(input.message);
    await gitOpsRepo.record(this.env.pool, { workspaceId, codeWorkspaceId: id, runId: input.runId ?? null, kind: 'commit', ref: branch, sha, message: input.message, performedBy: input.userId });
    await codeWorkspacesRepo.setHead(this.env.pool, id, sha, branch);
    if (input.runId) await codeRunsRepo.update(this.env.pool, input.runId, { finalCommit: sha, agentBranch: branch });
    await this.publish(id, 'commit.created', { sha, branch, message: input.message.split('\n')[0], files });
    return { sha, branch, files };
  }

  async push(id: string, workspaceId: string, input: { userId: string; runId?: string | null }) {
    const row = await this.row(id, workspaceId);
    const git = this.checkout(id).git;
    const branch = await git.currentBranch();
    if (!branch.startsWith(AGENT_BRANCH_PREFIX)) throw new CodeWorkspaceError(`Only agent branches (${AGENT_BRANCH_PREFIX}…) can be pushed from NeuroFlow; current branch is ${branch}`);
    if (!row.repository.canPush) throw new CodeWorkspaceError('The connected account does not have push permission for this repository');
    await git.push(branch, (await this.gitAuth(row)) ?? { token: '' });
    const sha = await git.head();
    await gitOpsRepo.record(this.env.pool, { workspaceId, codeWorkspaceId: id, runId: input.runId ?? null, kind: 'push', ref: branch, sha, performedBy: input.userId });
    await this.publish(id, 'push.completed', { branch, remote: row.repository.fullName, sha });
    return { branch, sha, remote: row.repository.fullName };
  }

  async createBranch(id: string, workspaceId: string, input: { name: string; userId: string }) {
    await this.row(id, workspaceId);
    const git = this.checkout(id).git;
    const branch = agentBranchName(input.name.replace(new RegExp(`^${AGENT_BRANCH_PREFIX}`), ''));
    const from = await git.currentBranch();
    if ((await git.branches()).includes(branch)) await git.checkout(branch);
    else {
      await git.createBranch(branch);
      await gitOpsRepo.record(this.env.pool, { workspaceId, codeWorkspaceId: id, runId: null, kind: 'branch', ref: branch, performedBy: input.userId });
    }
    await codeWorkspacesRepo.setHead(this.env.pool, id, await git.head(), branch);
    await this.publish(id, 'branch.created', { branch, from });
    return { branch, from };
  }

  /** Switches local branches (Branches panel). Refuses with uncommitted changes. */
  async checkoutBranch(id: string, workspaceId: string, branch: string) {
    await this.row(id, workspaceId);
    const git = this.checkout(id).git;
    if ((await git.status()).length > 0) throw new CodeWorkspaceError('Commit or discard your changes before switching branches');
    await git.checkout(branch);
    await codeWorkspacesRepo.setHead(this.env.pool, id, await git.head(), branch);
    await this.publish(id, 'workspace.status', { status: 'ready', branch });
    return { branch };
  }

  async createPullRequest(id: string, workspaceId: string, input: { title: string; body: string; draft: boolean; userId: string; runId?: string | null }) {
    const row = await this.row(id, workspaceId);
    const gh = await this.github(row);
    if (!gh) throw new CodeWorkspaceError('This repository is not connected to GitHub');
    const head = await this.checkout(id).git.currentBranch();
    if (!head.startsWith(AGENT_BRANCH_PREFIX)) throw new CodeWorkspaceError('Open pull requests from an agent branch');
    const pr = await gh.createPullRequest(row.repository.owner, row.repository.name, { title: input.title, body: input.body, head, base: row.baseBranch, draft: input.draft });
    await gitOpsRepo.recordPullRequest(this.env.pool, { workspaceId, codeWorkspaceId: id, runId: input.runId ?? null, number: pr.number, url: pr.htmlUrl, title: pr.title, head: pr.head, base: pr.base });
    await gitOpsRepo.record(this.env.pool, { workspaceId, codeWorkspaceId: id, runId: input.runId ?? null, kind: 'pull_request', ref: head, url: pr.htmlUrl, message: pr.title, performedBy: input.userId });
    await this.publish(id, 'pull_request.created', { number: pr.number, url: pr.htmlUrl, title: pr.title, head: pr.head, base: pr.base });
    return pr;
  }

  /** CodeServices for the Tool Runtime (worker side). */
  toolServices(): CodeServices {
    return {
      sandbox: this.env.sandbox,
      store: dbCodeStore(this.env.pool),
      open: async ({ workspaceId, codeWorkspaceId }) => this.open(codeWorkspaceId, workspaceId),
    };
  }

  async open(id: string, workspaceId: string): Promise<OpenCodeWorkspace> {
    const row = await this.row(id, workspaceId);
    if (row.status !== 'ready' && row.status !== 'syncing') throw new CodeWorkspaceError(`The code workspace is not ready (${row.status})`);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      repository: {
        id: row.repository.id,
        provider: row.repository.provider,
        owner: row.repository.owner,
        name: row.repository.name,
        fullName: row.repository.fullName,
        defaultBranch: row.repository.defaultBranch,
        canPush: row.repository.canPush,
      },
      baseBranch: row.baseBranch,
      baseCommit: row.baseCommit,
      commands: row.commands,
      checkout: this.checkout(id),
      github: () => this.github(row),
      gitAuth: () => this.gitAuth(row),
    };
  }
}

export class CodeWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeWorkspaceError';
  }
}

export class CodeWorkspaceNotFound extends CodeWorkspaceError {
  constructor() {
    super('Code workspace not found');
    this.name = 'CodeWorkspaceNotFound';
  }
}

/** PostgreSQL implementation of the Code Agent persistence port. */
export function dbCodeStore(pool: Queryable): CodeStore {
  return {
    createPatch: (i) => patchesRepo.create(pool, i),
    setPatchStatus: (id, status) => patchesRepo.setStatus(pool, id, status),
    startExecution: (i) => sandboxRepo.start(pool, i),
    denyExecution: (i) => sandboxRepo.denied(pool, i),
    finishExecution: (id, i) => sandboxRepo.finish(pool, id, i),
    recordTest: (i) => sandboxRepo.recordTest(pool, i),
    recordGitOperation: (i) => gitOpsRepo.record(pool, i),
    recordPullRequest: (i) => gitOpsRepo.recordPullRequest(pool, i),
    addContext: (runId, item) => codeRunsRepo.addContext(pool, runId, item),
    updateCodeRun: (runId, patch) => codeRunsRepo.update(pool, runId, patch),
    setHead: (id, head, branch) => codeWorkspacesRepo.setHead(pool, id, head, branch),
    lastTest: async (runId) => {
      const { rows } = await pool.query(
        `SELECT t.passed, s.command FROM test_executions t JOIN sandbox_executions s ON s.id = t.sandbox_execution_id
          WHERE t.run_id = $1 ORDER BY t.created_at DESC LIMIT 1`,
        [runId],
      );
      return rows[0] ? { passed: rows[0].passed as boolean, command: rows[0].command as string } : null;
    },
  };
}
