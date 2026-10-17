import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalMode } from '@neuroflow/contracts';
import { Git } from '../git';
import { GitHubClient } from '../github';
import type { Sandbox } from '../sandbox';
import type { CodeServices, CodeStore, OpenCodeWorkspace } from '../services';
import { RepoCheckout } from '../workspace';

/**
 * A real git repository for tests: a bare "remote" plus a working clone with an initial commit.
 * Nothing is mocked — git commands run for real.
 */
export async function createFixtureRepo(files: Record<string, string>, opts: { branch?: string } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nf-repo-'));
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  const branch = opts.branch ?? 'main';
  await mkdir(remote, { recursive: true });
  await new Git(remote).run(['init', '--bare', `--initial-branch=${branch}`]);
  await mkdir(work, { recursive: true });
  const seed = new Git(work, { author: { name: 'Fixture', email: 'fixture@neuroflow.test' } });
  await seed.run(['init', `--initial-branch=${branch}`]);
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(work, ...p.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await seed.run(['add', '--all']);
  await seed.run(['commit', '-m', 'Initial commit']);
  await seed.run(['remote', 'add', 'origin', remote]);
  await seed.run(['push', 'origin', branch]);
  return {
    dir,
    remote,
    work,
    branch,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Clones a fixture remote into a code-workspace checkout (like workspace provisioning). */
export async function checkoutFixture(remote: string, baseDir: string, id: string, branch = 'main') {
  const p = RepoCheckout.paths(baseDir, id);
  await Git.clone(remote, p.root, { branch });
  await mkdir(p.cacheDir, { recursive: true });
  return new RepoCheckout(p.root, p.cacheDir, { name: 'NeuroFlow Agent', email: 'agent@neuroflow.test' });
}

/** In-memory CodeStore for tests (records everything for assertions). */
export class MemoryCodeStore implements CodeStore {
  patches: Array<{ id: string; status: string; files: unknown[]; diff: string; toolCallId: string; validation: string }> = [];
  executions: Array<{ id: string; command: string; kind: string; status: string; output: string; exitCode: number | null }> = [];
  tests: Array<{ passed: boolean; executionId: string }> = [];
  gitOps: Array<{ kind: string; ref?: string; sha?: string; url?: string }> = [];
  pullRequests: Array<{ number: number; url: string }> = [];
  context: Array<{ kind: string; path?: string }> = [];
  codeRun: Record<string, unknown> = {};
  heads: Array<{ head: string; branch?: string }> = [];
  private n = 0;
  private id = () => `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;

  async createPatch(i: Parameters<CodeStore['createPatch']>[0]) {
    const id = this.id();
    this.patches.push({ id, status: i.status, files: i.files, diff: i.diff, toolCallId: i.toolCallId, validation: i.validation });
    return { id };
  }
  async setPatchStatus(id: string, status: string) {
    const p = this.patches.find((x) => x.id === id);
    if (p) p.status = status;
  }
  async startExecution(i: Parameters<CodeStore['startExecution']>[0]) {
    const id = this.id();
    this.executions.push({ id, command: i.command, kind: i.kind, status: 'running', output: '', exitCode: null });
    return id;
  }
  async denyExecution(i: Parameters<CodeStore['denyExecution']>[0]) {
    const id = this.id();
    this.executions.push({ id, command: i.command, kind: i.kind, status: 'denied', output: i.reason, exitCode: null });
    return id;
  }
  async finishExecution(id: string, i: Parameters<CodeStore['finishExecution']>[1]) {
    const e = this.executions.find((x) => x.id === id);
    if (e) Object.assign(e, { status: i.status, output: i.output, exitCode: i.exitCode });
  }
  async recordTest(i: Parameters<CodeStore['recordTest']>[0]) {
    this.tests.push({ passed: i.passed, executionId: i.executionId });
  }
  async recordGitOperation(i: Parameters<CodeStore['recordGitOperation']>[0]) {
    this.gitOps.push({ kind: i.kind, ref: i.ref, sha: i.sha, url: i.url });
  }
  async recordPullRequest(i: Parameters<CodeStore['recordPullRequest']>[0]) {
    this.pullRequests.push({ number: i.number, url: i.url });
  }
  async addContext(_runId: string, item: { kind: string; path?: string }) {
    this.context.push(item);
  }
  async updateCodeRun(_runId: string, patch: Record<string, unknown>) {
    Object.assign(this.codeRun, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  }
  async setHead(_id: string, head: string, branch?: string) {
    this.heads.push({ head, branch });
  }
  async lastTest() {
    const t = this.tests.at(-1);
    return t ? { passed: t.passed, command: this.executions.find((e) => e.id === t.executionId)?.command ?? '' } : null;
  }
}

/** CodeServices over a single checkout (no database). */
export function localCodeServices(input: {
  checkout: RepoCheckout;
  sandbox: Sandbox;
  store?: MemoryCodeStore;
  codeWorkspaceId?: string;
  workspaceId?: string;
  provider?: 'github' | 'local';
  owner?: string;
  name?: string;
  canPush?: boolean;
  baseBranch?: string;
  github?: { token: string; baseUrl: string };
  commands?: Record<string, string>;
}): CodeServices & { store: MemoryCodeStore } {
  const store = input.store ?? new MemoryCodeStore();
  const ws: OpenCodeWorkspace = {
    id: input.codeWorkspaceId ?? '11111111-1111-4111-8111-111111111111',
    workspaceId: input.workspaceId ?? 'ws',
    repository: {
      id: '22222222-2222-4222-8222-222222222222',
      provider: input.provider ?? 'local',
      owner: input.owner ?? 'acme',
      name: input.name ?? 'demo',
      fullName: `${input.owner ?? 'acme'}/${input.name ?? 'demo'}`,
      defaultBranch: input.baseBranch ?? 'main',
      canPush: input.canPush ?? true,
    },
    baseBranch: input.baseBranch ?? 'main',
    baseCommit: null,
    commands: input.commands ?? {},
    checkout: input.checkout,
    github: async () => (input.github ? new GitHubClient(input.github.token, { baseUrl: input.github.baseUrl }) : null),
    gitAuth: async () => (input.github ? { token: input.github.token } : undefined),
  };
  return {
    store,
    sandbox: input.sandbox,
    open: async ({ codeWorkspaceId }) => {
      if (codeWorkspaceId !== ws.id) throw new Error('Unknown code workspace');
      return ws;
    },
  };
}

export const codeContext = (codeWorkspaceId: string, approvalMode: ApprovalMode = 'review') => ({
  codeWorkspaceId,
  approvalMode,
});

type MockRoute = (req: { method: string; path: string; body: unknown; query: URLSearchParams; auth: string | undefined }) => { status?: number; body?: unknown } | undefined;

/** Mock GitHub REST API (records requests; responses supplied per test). */
export async function startMockGitHub(route: MockRoute) {
  const requests: Array<{ method: string; path: string; body: unknown; auth?: string }> = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = raw ? JSON.parse(raw) : undefined;
    const auth = req.headers.authorization;
    requests.push({ method: req.method ?? 'GET', path: url.pathname, body, auth });
    const out = route({ method: req.method ?? 'GET', path: url.pathname, body, query: url.searchParams, auth }) ?? { status: 404, body: { message: 'Not Found' } };
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, read:org' });
    res.end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
