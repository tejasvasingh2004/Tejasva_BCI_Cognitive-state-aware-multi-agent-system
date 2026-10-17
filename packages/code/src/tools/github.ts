import { z } from 'zod';
import { Scopes } from '@neuroflow/contracts';
import { defineTool, ToolExecutionError, type Prepared, type ToolContext, type ToolDefinition } from '@neuroflow/tools';
import { GitHubError, type GitHubClient } from '../github';
import { assertModeAllows, openFor, type CodeServices, type OpenCodeWorkspace } from '../services';
import { AGENT_BRANCH_PREFIX } from './git';

async function client(services: CodeServices, ctx: ToolContext): Promise<{ gh: GitHubClient; ws: OpenCodeWorkspace; mode: Awaited<ReturnType<typeof openFor>>['mode'] }> {
  const { ws, mode } = await openFor(services, ctx);
  if (ws.repository.provider !== 'github') throw new ToolExecutionError('This repository is not connected to GitHub');
  const gh = await ws.github();
  if (!gh) throw new ToolExecutionError('No GitHub connection is available for this repository');
  return { gh, ws, mode };
}

function ghFail(err: unknown): never {
  if (err instanceof GitHubError) throw new ToolExecutionError(`GitHub: ${err.message}`, err.code === 'unavailable' || err.code === 'rate_limited');
  throw err;
}

export function githubTools(services: CodeServices): ToolDefinition[] {
  const read = { riskLevel: 'low' as const, requiresApproval: false, sideEffects: false, permissions: [Scopes.codeRead], timeoutMs: 30_000, maxRetries: 1 };
  const write = { riskLevel: 'high' as const, requiresApproval: false, sideEffects: true, permissions: [Scopes.codePublish], timeoutMs: 60_000 };
  const stateArg = z.enum(['open', 'closed', 'all']).optional();

  const getRepository = defineTool({
    ...read,
    name: 'get_repository',
    description: 'Get GitHub metadata for the current repository (default branch, visibility, description, your permissions).',
    input: z.object({}),
    async execute(_a, ctx) {
      const { gh, ws } = await client(services, ctx);
      const r = await gh.getRepository(ws.repository.owner, ws.repository.name).catch(ghFail);
      return { fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private, description: r.description, permissions: r.permissions, url: r.htmlUrl };
    },
    summarize: (o) => o.fullName,
  });

  const getBranch = defineTool({
    ...read,
    name: 'get_branch',
    description: 'Get a branch on GitHub (latest commit and whether it is protected). Defaults to the base branch.',
    input: z.object({ name: z.string().max(250).optional() }),
    async execute({ name }, ctx) {
      const { gh, ws } = await client(services, ctx);
      return gh.getBranch(ws.repository.owner, ws.repository.name, name ?? ws.baseBranch).catch(ghFail);
    },
    summarize: (o) => `${o.name}${o.protected ? ' (protected)' : ''}`,
  });

  const getPulls = defineTool({
    ...read,
    name: 'get_pull_requests',
    description: 'List pull requests of the repository.',
    input: z.object({ state: stateArg }),
    async execute({ state }, ctx) {
      const { gh, ws } = await client(services, ctx);
      const prs = await gh.listPullRequests(ws.repository.owner, ws.repository.name, state ?? 'open').catch(ghFail);
      return { count: prs.length, pullRequests: prs.map((p) => `#${p.number} [${p.state}${p.draft ? ', draft' : ''}] ${p.title} (${p.head} → ${p.base}) by ${p.author}`) };
    },
    summarize: (o) => `${o.count} pull request(s)`,
  });

  const getIssues = defineTool({
    ...read,
    name: 'get_issues',
    description: 'List issues of the repository (titles, labels and a short body).',
    input: z.object({ state: stateArg }),
    maxResultChars: 12_000,
    async execute({ state }, ctx) {
      const { gh, ws } = await client(services, ctx);
      const issues = await gh.listIssues(ws.repository.owner, ws.repository.name, state ?? 'open').catch(ghFail);
      return { count: issues.length, issues: issues.map((i) => ({ number: i.number, title: i.title, labels: i.labels, body: i.body?.slice(0, 600) ?? '' })) };
    },
    summarize: (o) => `${o.count} issue(s)`,
  });

  type IssueState = { title: string; body: string };
  const createIssue = defineTool({
    ...write,
    name: 'create_issue',
    description: 'Open a GitHub issue. Always requires the user\'s approval.',
    input: z.object({ title: z.string().trim().min(3).max(250), body: z.string().max(20_000).default('') }),
    async prepare({ title, body }, ctx): Promise<Prepared<IssueState>> {
      const { mode, ws } = await client(services, ctx);
      assertModeAllows(mode, 'publish');
      return { approval: { reason: 'Creates a public record on GitHub', preview: { repository: ws.repository.fullName, title, body: body.slice(0, 2000) } }, state: { title, body } };
    },
    async execute(_a, ctx, prepared) {
      const s = prepared?.state as IssueState;
      const { gh, ws } = await client(services, ctx);
      const issue = await gh.createIssue(ws.repository.owner, ws.repository.name, { title: s.title, body: s.body }).catch(ghFail);
      return { number: issue.number, url: issue.htmlUrl };
    },
    summarize: (o: { number: number }) => `Opened issue #${o.number}`,
  });

  type PrState = { title: string; body: string; draft: boolean; head: string; base: string; ws: OpenCodeWorkspace };
  const createPullRequest = defineTool({
    ...write,
    name: 'create_pull_request',
    description: `Open a pull request from the pushed agent branch into the base branch. Always requires the user's approval. Never merges.`,
    input: z.object({
      title: z.string().trim().min(3).max(250),
      body: z.string().max(60_000).default('').describe('Summary of changes, test results and anything reviewers should know'),
      draft: z.boolean().default(true),
    }),
    async prepare({ title, body, draft }, ctx): Promise<Prepared<PrState>> {
      const { mode, ws, gh } = await client(services, ctx);
      assertModeAllows(mode, 'publish');
      const head = await ws.checkout.git.currentBranch();
      if (!head.startsWith(AGENT_BRANCH_PREFIX)) throw new ToolExecutionError(`Pull requests are opened from agent branches; current branch is ${head}`);
      await gh.getBranch(ws.repository.owner, ws.repository.name, head).catch(() => {
        throw new ToolExecutionError(`Branch ${head} is not on GitHub yet — push it first`);
      });
      return {
        approval: { reason: 'Opens a pull request on GitHub', preview: { repository: ws.repository.fullName, head, base: ws.baseBranch, title, draft } },
        state: { title, body, draft, head, base: ws.baseBranch, ws },
      };
    },
    async execute(_a, ctx, prepared) {
      const s = prepared?.state as PrState;
      const { gh } = await client(services, ctx);
      const pr = await gh.createPullRequest(s.ws.repository.owner, s.ws.repository.name, { title: s.title, body: s.body, head: s.head, base: s.base, draft: s.draft }).catch(ghFail);
      ctx.emit('pull_request.created', { number: pr.number, url: pr.htmlUrl, title: pr.title, head: pr.head, base: pr.base });
      await services.store.recordPullRequest({ workspaceId: ctx.workspaceId, codeWorkspaceId: s.ws.id, runId: ctx.runId, number: pr.number, url: pr.htmlUrl, title: pr.title, head: pr.head, base: pr.base });
      await services.store.recordGitOperation({ workspaceId: ctx.workspaceId, codeWorkspaceId: s.ws.id, runId: ctx.runId, kind: 'pull_request', ref: pr.head, url: pr.htmlUrl, message: pr.title });
      return { number: pr.number, url: pr.htmlUrl };
    },
    summarize: (o: { number: number }) => `Opened PR #${o.number}`,
  });

  type ReviewState = { number: number; body: string };
  const reviewPullRequest = defineTool({
    ...write,
    name: 'review_pull_request',
    description: 'Post a review comment on a pull request (comment only — never approves or merges). Requires the user\'s approval.',
    input: z.object({ number: z.number().int().min(1), body: z.string().trim().min(3).max(60_000) }),
    async prepare({ number, body }, ctx): Promise<Prepared<ReviewState>> {
      const { mode, ws } = await client(services, ctx);
      assertModeAllows(mode, 'publish');
      return { approval: { reason: 'Posts a review on GitHub', preview: { repository: ws.repository.fullName, pullRequest: number, body: body.slice(0, 2000) } }, state: { number, body } };
    },
    async execute(_a, ctx, prepared) {
      const s = prepared?.state as ReviewState;
      const { gh, ws } = await client(services, ctx);
      const review = await gh.reviewPullRequest(ws.repository.owner, ws.repository.name, s.number, s.body).catch(ghFail);
      return { pullRequest: s.number, reviewId: review.id, url: review.htmlUrl };
    },
    summarize: (o: { pullRequest: number }) => `Reviewed PR #${o.pullRequest}`,
  });

  return [getRepository, getBranch, getPulls, getIssues, createIssue, createPullRequest, reviewPullRequest] as ToolDefinition[];
}
