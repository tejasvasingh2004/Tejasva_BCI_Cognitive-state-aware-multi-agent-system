import { z } from 'zod';
import { Scopes } from '@neuroflow/contracts';
import { defineTool, ToolExecutionError, type Prepared, type ToolContext, type ToolDefinition } from '@neuroflow/tools';
import { GitError } from '../git';
import { GitHubError } from '../github';
import { summarizePatch } from '../patch';
import { assertModeAllows, openFor, type CodeServices, type OpenCodeWorkspace } from '../services';
import { emitDiffUpdate } from './editing';

export const AGENT_BRANCH_PREFIX = 'neuroflow/agent/';

export function agentBranchName(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${AGENT_BRANCH_PREFIX}${slug || 'change'}`;
}

function gitFail(err: unknown): never {
  if (err instanceof GitError || err instanceof GitHubError) throw new ToolExecutionError(err.message, err instanceof GitError && err.code === 'network');
  throw err;
}

/** Creates (or switches to an existing) agent branch and records it. */
async function ensureAgentBranch(services: CodeServices, ctx: ToolContext, ws: OpenCodeWorkspace, name: string) {
  const git = ws.checkout.git;
  const from = await git.currentBranch();
  if (from === name) return name;
  const existing = await git.branches();
  if (existing.includes(name)) await git.checkout(name).catch(gitFail);
  else {
    await git.createBranch(name).catch(gitFail);
    ctx.emit('branch.created', { branch: name, from });
    await services.store.recordGitOperation({ workspaceId: ctx.workspaceId, codeWorkspaceId: ws.id, runId: ctx.runId, kind: 'branch', ref: name });
  }
  await services.store.updateCodeRun(ctx.runId, { agentBranch: name }).catch(() => {});
  await services.store.setHead(ws.id, await git.head(), name).catch(() => {});
  return name;
}

type CommitState = { ws: OpenCodeWorkspace; message: string; branch: string; needsBranch: boolean };
type PushState = { ws: OpenCodeWorkspace; branch: string };

export function gitTools(services: CodeServices): ToolDefinition[] {
  const read = { riskLevel: 'low' as const, requiresApproval: false, sideEffects: false, permissions: [Scopes.codeRead], timeoutMs: 30_000 };

  const gitStatus = defineTool({
    ...read,
    name: 'git_status',
    description: 'Show the current branch and changed files (modified, added, deleted, untracked).',
    input: z.object({}),
    async execute(_a, ctx) {
      const { ws } = await openFor(services, ctx);
      const [branch, status] = await Promise.all([ws.checkout.git.currentBranch(), ws.checkout.git.status()]);
      return { branch, baseBranch: ws.baseBranch, clean: status.length === 0, changes: status.map((s) => `${s.kind}: ${s.path}`) };
    },
    summarize: (o) => (o.clean ? `${o.branch}: clean` : `${o.branch}: ${o.changes.length} change(s)`),
  });

  const gitDiff = defineTool({
    ...read,
    name: 'git_diff',
    description: 'Show the unified diff of uncommitted changes (optionally limited to some paths).',
    input: z.object({ paths: z.array(z.string().max(500)).max(20).optional() }),
    maxResultChars: 24_000,
    async execute({ paths }, ctx) {
      const { ws } = await openFor(services, ctx);
      const { files, additions, deletions, diff } = paths?.length
        ? await (async () => {
            const d = await ws.checkout.git.diff(paths);
            const f = summarizePatch(d);
            return { files: f, additions: f.reduce((n, x) => n + x.additions, 0), deletions: f.reduce((n, x) => n + x.deletions, 0), diff: d };
          })()
        : await emitDiffUpdate(services, ctx, ws);
      return {
        summary: files.map((f) => `${f.path} +${f.additions} -${f.deletions}`),
        additions,
        deletions,
        diff: diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n…[truncated]` : diff,
      };
    },
    summarize: (o) => `${o.summary.length} file(s) +${o.additions} -${o.deletions}`,
  });

  const gitLog = defineTool({
    ...read,
    name: 'git_log',
    description: 'Show recent commits on the current branch.',
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    async execute({ limit }, ctx) {
      const { ws } = await openFor(services, ctx);
      const commits = await ws.checkout.git.log(limit ?? 10);
      return { commits: commits.map((c) => `${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`) };
    },
    summarize: (o) => `${o.commits.length} commit(s)`,
  });

  const createBranch = defineTool({
    name: 'create_branch',
    description: `Create and switch to an agent branch for this task. Names are always under "${AGENT_BRANCH_PREFIX}" (e.g. "${AGENT_BRANCH_PREFIX}fix-login-timeout").`,
    input: z.object({ name: z.string().min(1).max(100).describe('Short task name; the agent prefix is added automatically') }),
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: true,
    permissions: [Scopes.codeWrite],
    timeoutMs: 30_000,
    async execute({ name }, ctx) {
      const { ws, mode } = await openFor(services, ctx);
      assertModeAllows(mode, 'git_local');
      const branch = agentBranchName(name.replace(new RegExp(`^${AGENT_BRANCH_PREFIX}`), ''));
      await ensureAgentBranch(services, ctx, ws, branch);
      return { branch, from: ws.baseBranch };
    },
    summarize: (o) => `On ${o.branch}`,
  });

  const commit = defineTool({
    name: 'commit',
    description: `Commit all current changes with a message. If on the base branch, an agent branch (${AGENT_BRANCH_PREFIX}…) is created first. Requires approval in Review mode.`,
    input: z.object({ message: z.string().trim().min(3).max(2000).describe('Conventional, descriptive commit message') }),
    riskLevel: 'medium',
    requiresApproval: false,
    sideEffects: true,
    permissions: [Scopes.codeWrite],
    timeoutMs: 60_000,
    async prepare({ message }, ctx): Promise<Prepared<CommitState>> {
      const { ws, mode } = await openFor(services, ctx);
      assertModeAllows(mode, 'git_local');
      const git = ws.checkout.git;
      const [status, branch] = await Promise.all([git.status(), git.currentBranch()]);
      if (status.length === 0) throw new ToolExecutionError('There are no changes to commit');
      const onBase = !branch.startsWith(AGENT_BRANCH_PREFIX);
      const target = onBase ? agentBranchName(message.split('\n')[0]!) : branch;
      const state: CommitState = { ws, message, branch: target, needsBranch: onBase };
      if (mode !== 'review') return { state };
      const files = summarizePatch(await git.diff());
      const tests = await services.store.lastTest(ctx.runId);
      return {
        approval: {
          reason: 'Review mode: commits are created only after you approve them',
          preview: {
            branch: target,
            message,
            files: files.map((f) => `${f.path} +${f.additions} -${f.deletions}`),
            tests: tests ? (tests.passed ? `passed (${tests.command})` : `failing (${tests.command})`) : 'not run',
          },
        },
        state,
      };
    },
    async execute(_a, ctx, prepared) {
      const s = prepared?.state as CommitState;
      if (s.needsBranch) await ensureAgentBranch(services, ctx, s.ws, s.branch);
      const files = (await s.ws.checkout.git.status()).length;
      const sha = await s.ws.checkout.git.commitAll(s.message).catch(gitFail);
      ctx.emit('commit.created', { sha, branch: s.branch, message: s.message.split('\n')[0]!, files });
      await services.store.recordGitOperation({ workspaceId: ctx.workspaceId, codeWorkspaceId: s.ws.id, runId: ctx.runId, kind: 'commit', ref: s.branch, sha, message: s.message });
      await services.store.updateCodeRun(ctx.runId, { finalCommit: sha, agentBranch: s.branch }).catch(() => {});
      await services.store.setHead(s.ws.id, sha, s.branch).catch(() => {});
      await emitDiffUpdate(services, ctx, s.ws).catch(() => {});
      return { sha, branch: s.branch, files };
    },
    summarize: (o: { sha: string; branch: string }) => `Committed ${o.sha.slice(0, 8)} on ${o.branch}`,
  });

  const push = defineTool({
    name: 'push',
    description: `Push the current agent branch to the remote. Always requires the user's approval. Only ${AGENT_BRANCH_PREFIX}* branches can be pushed.`,
    input: z.object({}),
    riskLevel: 'high',
    requiresApproval: false,
    sideEffects: true,
    permissions: [Scopes.codePublish],
    timeoutMs: 5 * 60_000,
    async prepare(_a, ctx): Promise<Prepared<PushState>> {
      const { ws, mode } = await openFor(services, ctx);
      assertModeAllows(mode, 'publish');
      const branch = await ws.checkout.git.currentBranch();
      if (!branch.startsWith(AGENT_BRANCH_PREFIX)) {
        throw new ToolExecutionError(`Only agent branches (${AGENT_BRANCH_PREFIX}…) can be pushed; current branch is ${branch}. Commit first.`);
      }
      if (!ws.repository.canPush) throw new ToolExecutionError('The connected account does not have push permission for this repository');
      const commits = await ws.checkout.git.log(5);
      return {
        approval: { reason: 'Pushing publishes commits to the remote repository', preview: { branch, remote: ws.repository.fullName, commits: commits.map((c) => `${c.sha.slice(0, 8)} ${c.subject}`) } },
        state: { ws, branch },
      };
    },
    async execute(_a, ctx, prepared) {
      const s = prepared?.state as PushState;
      const auth = await s.ws.gitAuth();
      await s.ws.checkout.git.push(s.branch, auth ?? { token: '' }).catch(gitFail);
      const sha = await s.ws.checkout.git.head();
      ctx.emit('push.completed', { branch: s.branch, remote: s.ws.repository.fullName, sha });
      await services.store.recordGitOperation({ workspaceId: ctx.workspaceId, codeWorkspaceId: s.ws.id, runId: ctx.runId, kind: 'push', ref: s.branch, sha });
      return { branch: s.branch, sha, remote: s.ws.repository.fullName };
    },
    summarize: (o: { branch: string }) => `Pushed ${o.branch}`,
  });

  return [gitStatus, gitDiff, gitLog, createBranch, commit, push] as ToolDefinition[];
}
