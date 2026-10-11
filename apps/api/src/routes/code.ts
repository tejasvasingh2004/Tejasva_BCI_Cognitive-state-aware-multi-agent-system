import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApprovalMode,
  CodeRunRequestBody,
  CodeSearchBody,
  CommitBody,
  CreateCodeWorkspaceBody,
  CreatePullRequestBody,
  PatchDecisionBody,
  PlanDecisionBody,
  RunCommandBody,
  RunRequest,
  SaveFileBody,
  Scopes,
  type Principal,
} from '@neuroflow/contracts';
import {
  classifyCommand,
  CodeWorkspaceError,
  CodeWorkspaceNotFound,
  FileTooLargeError,
  findReferences,
  findSymbol,
  GitError,
  GitHubClient,
  normalizeRepoPath,
  PathPolicyError,
  publicCodeWorkspace,
  summarizePatch,
} from '@neuroflow/code';
import {
  codeApprovalsRepo,
  codeRunsRepo,
  codeWorkspacesRepo,
  executionRepo,
  githubRepo,
  gitOpsRepo,
  patchesRepo,
  runEventsRepo,
  runsRepo,
  sandboxRepo,
  type CodeWorkspaceRow,
} from '@neuroflow/db';
import { audit } from '../audit';
import { requireScope } from '../auth';
import type { AppDeps } from '../deps';
import { forbidden, HttpError, notFound } from '../errors';
import type { RunManager } from '../run-manager';
import { openSse } from '../sse';
import { ghError } from './github';
import { publicRun } from './runs';

const IdParams = z.object({ id: z.string().uuid() });
const ExecParams = z.object({ id: z.string().uuid(), execId: z.string().uuid() });
const FileQuery = z.object({ path: z.string().min(1).max(500), ref: z.enum(['HEAD', 'base']).optional() });

/** Maps code-layer errors onto the API error contract. */
function codeError(err: unknown): never {
  if (err instanceof CodeWorkspaceNotFound) throw notFound('Code workspace');
  if (err instanceof PathPolicyError) throw new HttpError('bad_request', err.message);
  if (err instanceof FileTooLargeError) throw new HttpError('bad_request', err.message);
  if (err instanceof CodeWorkspaceError) throw new HttpError('conflict', err.message);
  if (err instanceof GitError) throw new HttpError(err.code === 'auth' ? 'forbidden' : err.code === 'network' ? 'unavailable' : 'conflict', err.message);
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw notFound('File');
  return ghError(err);
}

export async function codeRoutes(app: FastifyInstance, deps: AppDeps, runs: RunManager) {
  const code = deps.code;

  const workspaceOf = async (p: Principal, id: string): Promise<CodeWorkspaceRow> => {
    const row = await codeWorkspacesRepo.get(deps.pool, id, p.workspaceId);
    if (!row || row.status === 'archived') throw notFound('Code workspace');
    return row;
  };
  const readyWorkspace = async (p: Principal, id: string) => {
    const row = await workspaceOf(p, id);
    if (row.status !== 'ready' && row.status !== 'syncing') throw new HttpError('conflict', `The code workspace is ${row.status}${row.error ? `: ${row.error}` : ''}`);
    return row;
  };
  const enqueueSync = (row: { id: string; workspaceId: string }) =>
    deps.queue.enqueueWorkspaceJob({ kind: 'workspace.sync', codeWorkspaceId: row.id, workspaceId: row.workspaceId }, `ws-sync-${row.id}-${Date.now()}`);

  // ------------------------------------------------------------------ workspaces

  app.get('/v1/code/workspaces', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    return { workspaces: (await codeWorkspacesRepo.list(deps.pool, p.workspaceId)).map(publicCodeWorkspace) };
  });

  /** Repository + branch → code workspace. Cloning happens in the worker; poll or follow events. */
  app.post('/v1/code/workspaces', async (req, reply) => {
    const p = requireScope(req, Scopes.codeWrite);
    const body = CreateCodeWorkspaceBody.parse(req.body);
    let repo;
    let branch: string;
    if (body.provider === 'github') {
      const conn = await githubRepo.get(deps.pool, body.connectionId, p.workspaceId, p.userId);
      if (!conn) throw notFound('GitHub connection');
      const gh = new GitHubClient(deps.secrets.open(conn.tokenEncrypted), { baseUrl: deps.config.GITHUB_API_URL });
      const meta = await gh.getRepository(body.owner, body.repo).catch(ghError);
      branch = body.branch ?? meta.defaultBranch;
      await gh.getBranch(meta.owner, meta.name, branch).catch(ghError);
      repo = await codeWorkspacesRepo.upsertRepository(deps.pool, {
        workspaceId: p.workspaceId,
        connectionId: conn.id,
        provider: 'github',
        owner: meta.owner,
        name: meta.name,
        defaultBranch: meta.defaultBranch,
        cloneUrl: meta.cloneUrl,
        htmlUrl: meta.htmlUrl,
        private: meta.private,
        // Repository access does not imply modification permission.
        canPush: meta.permissions.push,
      });
    } else {
      // Local repositories are a development convenience only.
      if (deps.config.AUTH_MODE !== 'dev') throw new HttpError('forbidden', 'Local repositories are only available in development mode');
      const abs = path.resolve(body.path);
      if (!(await stat(path.join(abs, '.git')).then(() => true, () => false)) && !(await stat(path.join(abs, 'HEAD')).then(() => true, () => false))) {
        throw new HttpError('bad_request', 'Not a git repository');
      }
      branch = body.branch ?? 'main';
      repo = await codeWorkspacesRepo.upsertRepository(deps.pool, {
        workspaceId: p.workspaceId,
        connectionId: null,
        provider: 'local',
        owner: 'local',
        name: path.basename(abs).replace(/\.git$/, ''),
        defaultBranch: branch,
        cloneUrl: abs,
        htmlUrl: null,
        private: true,
        canPush: true,
      });
    }
    const id = await codeWorkspacesRepo.create(deps.pool, {
      workspaceId: p.workspaceId,
      repositoryId: repo.id,
      createdBy: p.userId,
      branch,
      baseBranch: branch,
      approvalMode: body.approvalMode,
    });
    await enqueueSync({ id, workspaceId: p.workspaceId });
    void audit(deps, req, { action: 'code.workspace_created', targetType: 'code_workspace', targetId: id, metadata: { repository: `${repo.owner}/${repo.name}`, branch } });
    return reply.code(202).send({ workspace: publicCodeWorkspace((await codeWorkspacesRepo.get(deps.pool, id, p.workspaceId))!) });
  });

  app.get('/v1/code/workspaces/:id', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const row = await workspaceOf(p, id);
    const sandbox = await deps.code.env.sandbox.available();
    return { workspace: publicCodeWorkspace(row), commands: row.commands, sandboxAvailable: sandbox };
  });

  app.patch('/v1/code/workspaces/:id', async (req) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    const body = z.object({ approvalMode: ApprovalMode.optional(), commands: z.record(z.enum(['install', 'test', 'lint', 'build']), z.string().max(500)).optional() }).parse(req.body);
    await workspaceOf(p, id);
    if (body.approvalMode) await codeWorkspacesRepo.setApprovalMode(deps.pool, id, p.workspaceId, body.approvalMode);
    if (body.commands) {
      for (const cmd of Object.values(body.commands)) {
        if (classifyCommand(cmd, 'auto').decision === 'deny') throw new HttpError('bad_request', `Command not allowed: ${cmd}`);
      }
      await deps.pool.query('UPDATE code_workspaces SET commands = commands || $3::jsonb WHERE id = $1 AND workspace_id = $2', [id, p.workspaceId, JSON.stringify(body.commands)]);
    }
    return { workspace: publicCodeWorkspace(await workspaceOf(p, id)) };
  });

  app.delete('/v1/code/workspaces/:id', async (req, reply) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    if (!(await codeWorkspacesRepo.archive(deps.pool, id, p.workspaceId))) throw notFound('Code workspace');
    return reply.code(204).send();
  });

  app.post('/v1/code/workspaces/:id/sync', async (req, reply) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    const row = await workspaceOf(p, id);
    await enqueueSync(row);
    return reply.code(202).send({ ok: true });
  });

  // ------------------------------------------------------------------ files & search

  app.get('/v1/code/workspaces/:id/tree', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    await readyWorkspace(p, id);
    return code.checkout(id).tree().catch(codeError);
  });

  app.get('/v1/code/workspaces/:id/file', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const { path: file, ref } = FileQuery.parse(req.query);
    const row = await readyWorkspace(p, id);
    const checkout = code.checkout(id);
    if (ref) {
      const rel = normalizeRepoPath(file);
      const content = await checkout.git.show(ref === 'base' ? (row.baseCommit ?? 'HEAD') : 'HEAD', rel);
      return { path: rel, content, exists: content !== null };
    }
    const result = await checkout.read(file).catch(codeError);
    return result;
  });

  /** Manual edit from the editor (the user is the author; no approval needed). */
  app.put('/v1/code/workspaces/:id/file', async (req) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    const body = SaveFileBody.parse(req.body);
    await readyWorkspace(p, id);
    const checkout = code.checkout(id);
    const before = await checkout.readText(body.path).catch(codeError);
    await checkout.write(body.path, body.content).catch(codeError);
    const rel = normalizeRepoPath(body.path);
    await code.publish(id, 'file.modified', { path: rel, op: before === null ? 'create' : 'modify', by: 'user' });
    const summary = await code.diffSummary(id);
    await code.publish(id, 'git.diff.updated', { files: summary.files, additions: summary.additions, deletions: summary.deletions });
    return { path: rel, saved: true };
  });

  app.post('/v1/code/workspaces/:id/search', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const body = CodeSearchBody.parse(req.body);
    await readyWorkspace(p, id);
    const checkout = code.checkout(id);
    if (body.kind === 'files') {
      const { files } = await checkout.tree();
      const q = body.query.toLowerCase();
      return { results: files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 200).map((f) => ({ path: f.path, line: 0, text: '' })) };
    }
    if (body.kind === 'symbol') return { results: await findSymbol(checkout.git, body.query, 50) };
    if (body.kind === 'references') return { results: await findReferences(checkout.git, body.query, 200) };
    const results = await checkout.git
      .grep(body.query, { regex: body.kind === 'regex', ignoreCase: !body.caseSensitive, paths: body.paths, max: 300 })
      .catch(codeError);
    return { results };
  });

  // ------------------------------------------------------------------ git

  app.get('/v1/code/workspaces/:id/git', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const row = await readyWorkspace(p, id);
    const git = code.checkout(id).git;
    const [branch, status, branches, log] = await Promise.all([git.currentBranch(), git.status(), git.branches(), git.log(20)]).catch(codeError);
    const ops = await gitOpsRepo.list(deps.pool, id);
    return { branch, baseBranch: row.baseBranch, status, branches, log, operations: ops.slice(0, 20), canPush: row.repository.canPush };
  });

  app.get('/v1/code/workspaces/:id/diff', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    await readyWorkspace(p, id);
    const { path: only } = z.object({ path: z.string().max(500).optional() }).parse(req.query);
    if (only) {
      const diff = await code.checkout(id).git.diff([normalizeRepoPath(only)]).catch(codeError);
      return { diff, files: summarizePatch(diff) };
    }
    return code.diffSummary(id).catch(codeError);
  });

  app.post('/v1/code/workspaces/:id/git/branch', async (req) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
    return code.createBranch(id, p.workspaceId, { name, userId: p.userId }).catch(codeError);
  });

  app.post('/v1/code/workspaces/:id/git/checkout', async (req) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    const { branch } = z.object({ branch: z.string().min(1).max(250) }).parse(req.body);
    return code.checkoutBranch(id, p.workspaceId, branch).catch(codeError);
  });

  const commit = async (req: FastifyRequest, id: string, runId: string | null) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { message } = CommitBody.parse(req.body);
    const res = await code.commit(id, p.workspaceId, { message, userId: p.userId, runId }).catch(codeError);
    void audit(deps, req, { action: 'code.commit', targetType: 'code_workspace', targetId: id, metadata: { sha: res.sha, branch: res.branch, runId } });
    return res;
  };
  const push = async (req: FastifyRequest, id: string, runId: string | null) => {
    const p = requireScope(req, Scopes.codePublish);
    const res = await code.push(id, p.workspaceId, { userId: p.userId, runId }).catch(codeError);
    void audit(deps, req, { action: 'code.push', targetType: 'code_workspace', targetId: id, metadata: { branch: res.branch, sha: res.sha, runId } });
    return res;
  };
  const pullRequest = async (req: FastifyRequest, id: string, runId: string | null) => {
    const p = requireScope(req, Scopes.codePublish);
    const body = CreatePullRequestBody.parse(req.body);
    const pr = await code.createPullRequest(id, p.workspaceId, { ...body, userId: p.userId, runId }).catch(codeError);
    void audit(deps, req, { action: 'code.pull_request', targetType: 'code_workspace', targetId: id, metadata: { number: pr.number, url: pr.htmlUrl, runId } });
    return { number: pr.number, url: pr.htmlUrl, head: pr.head, base: pr.base };
  };

  app.post('/v1/code/workspaces/:id/git/commit', async (req) => commit(req, IdParams.parse(req.params).id, null));
  app.post('/v1/code/workspaces/:id/git/push', async (req) => push(req, IdParams.parse(req.params).id, null));
  app.post('/v1/code/workspaces/:id/git/pull-request', async (req) => pullRequest(req, IdParams.parse(req.params).id, null));

  // ------------------------------------------------------------------ terminal (sandbox)

  /** Runs a user command in the worker sandbox; output streams on the workspace event channel. */
  app.post('/v1/code/workspaces/:id/commands', async (req, reply) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    const body = RunCommandBody.parse(req.body);
    await readyWorkspace(p, id);
    // The user running a command is the approval; the deny list (system changes, exfiltration) still applies.
    const decision = classifyCommand(body.command, 'auto');
    if (decision.decision === 'deny') throw new HttpError('forbidden', `Command not allowed (${decision.reason})`);
    const correlationId = randomUUID();
    await deps.queue.enqueueWorkspaceJob(
      {
        kind: 'workspace.command',
        codeWorkspaceId: id,
        workspaceId: p.workspaceId,
        userId: p.userId,
        executionId: correlationId,
        command: body.command,
        commandKind: body.kind,
        network: decision.network,
      },
      `ws-cmd-${correlationId}`,
    );
    void audit(deps, req, { action: 'code.command_run', targetType: 'code_workspace', targetId: id, metadata: { command: body.command.slice(0, 200), kind: body.kind } });
    return reply.code(202).send({ correlationId, network: decision.network });
  });

  app.get('/v1/code/workspaces/:id/executions', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    await workspaceOf(p, id);
    const { runId } = z.object({ runId: z.string().uuid().optional() }).parse(req.query);
    return { executions: await sandboxRepo.list(deps.pool, id, { runId, limit: 50 }) };
  });

  app.get('/v1/code/workspaces/:id/executions/:execId', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id, execId } = ExecParams.parse(req.params);
    await workspaceOf(p, id);
    const e = await sandboxRepo.get(deps.pool, execId);
    if (!e || e.codeWorkspaceId !== id) throw notFound('Execution');
    return { execution: e };
  });

  /** Live workspace events (sync status, user command output, file changes) over SSE. */
  app.get('/v1/code/workspaces/:id/events', async (req, reply) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    await workspaceOf(p, id);
    const sse = openSse(req, reply);
    const stop = await deps.workspaceHub.follow(id, (e) => sse.send({ event: e.type, data: e }));
    // Signals that the subscription is live (and pushes the stream through buffering proxies).
    sse.comment('subscribed');
    sse.onClose(() => void stop());
    if (sse.closed) void stop();
  });

  app.get('/v1/code/workspaces/:id/runs', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    await workspaceOf(p, id);
    return { runs: await codeRunsRepo.listForWorkspace(deps.pool, id) };
  });

  // ------------------------------------------------------------------ code runs

  /** Structured Code Agent request → a normal NeuroFlow run with workspace context. */
  app.post('/v1/code/runs', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    if (!p.scopes.includes(Scopes.codeRead)) throw forbidden('Missing required scope "code:read"');
    const body = CodeRunRequestBody.parse(req.body);
    const row = await readyWorkspace(p, body.codeWorkspaceId);
    const approvalMode = body.approvalMode ?? row.approvalMode;
    if (approvalMode !== 'restricted' && !p.scopes.includes(Scopes.codeWrite)) {
      throw forbidden('Only Restricted (read-only) code runs are allowed without the "code:write" scope');
    }
    const request = RunRequest.parse({
      messages: [{ role: 'user', content: body.instruction }],
      conversationId: body.conversationId,
      mode: body.mode,
      ...(body.selectedModel ? { selectedModel: body.selectedModel } : {}),
      ...(body.reasoningBudget ? { reasoningBudget: body.reasoningBudget } : {}),
      workspaceContext: {
        codeWorkspaceId: row.id,
        approvalMode,
        ...(body.activeFile ? { activeFile: normalizeRepoPath(body.activeFile) } : {}),
        ...(body.selection ? { selectedLines: { start: body.selection.startLine, end: Math.max(body.selection.endLine, body.selection.startLine) } } : {}),
        ...(body.context?.length ? { relatedFiles: body.context.map(normalizeRepoPath) } : {}),
        ...(body.action ? { action: body.action } : {}),
        ...(body.planReview ? { planReview: true } : {}),
      },
    });
    const result = await runs.create(p, request, { source: 'workspace', idempotencyKey: req.headers['idempotency-key'] as string | undefined });
    return reply.code(result.created ? 201 : 200).send({
      run: publicRun(result.run),
      conversationId: result.conversationId,
      eventsUrl: `/v1/runs/${result.run.id}/events`,
    });
  });

  const codeRunOf = async (p: Principal, runId: string) => {
    const run = await runsRepo.get(deps.pool, runId, p.workspaceId);
    const codeRun = run ? await codeRunsRepo.get(deps.pool, runId) : null;
    // A queued code run has no code_runs row yet: fall back to its request context.
    const codeWorkspaceId = codeRun?.codeWorkspaceId ?? run?.request.workspaceContext?.codeWorkspaceId;
    if (!run || !codeWorkspaceId) throw notFound('Code run');
    return { run, codeRun, codeWorkspaceId };
  };

  app.get('/v1/code/runs/:id', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const { run, codeRun, codeWorkspaceId } = await codeRunOf(p, id);
    const [patches, executions, approvals, operations, context, details] = await Promise.all([
      patchesRepo.listForRun(deps.pool, id),
      sandboxRepo.list(deps.pool, codeWorkspaceId, { runId: id }),
      codeApprovalsRepo.listForRun(deps.pool, id),
      gitOpsRepo.list(deps.pool, codeWorkspaceId, id),
      codeRunsRepo.contextItems(deps.pool, id),
      executionRepo.runDetails(deps.pool, id),
    ]);
    return { run: publicRun(run), codeRun, codeWorkspaceId, patches, executions, approvals, operations, context, details };
  });

  // Code runs are runs: events and cancellation reuse the run endpoints.
  app.get('/v1/code/runs/:id/events', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    return reply.redirect(`/v1/runs/${id}/events${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`, 307);
  });

  app.post('/v1/code/runs/:id/cancel', async (req) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    await codeRunOf(p, id);
    return { run: publicRun(await runs.cancel(p, id)) };
  });

  const decide = async (req: FastifyRequest, approved: boolean) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    const body = PatchDecisionBody.parse(req.body ?? {});
    await codeRunOf(p, id);
    let toolCallId = body.toolCallId;
    if (body.patchId) {
      const patch = await patchesRepo.get(deps.pool, body.patchId, p.workspaceId);
      if (!patch || patch.runId !== id || !patch.toolCallId) throw notFound('Patch');
      toolCallId = patch.toolCallId;
    }
    if (!toolCallId) throw new HttpError('bad_request', 'patchId or toolCallId is required');
    await runs.approve(p, id, toolCallId, approved, body.reason);
    return { ok: true };
  };
  /** Plan Review: approve (optionally edited), request changes, or stop. */
  app.post('/v1/code/runs/:id/plan', async (req) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    await codeRunOf(p, id);
    await runs.decidePlan(p, id, PlanDecisionBody.parse(req.body));
    return { ok: true };
  });
  app.post('/v1/code/runs/:id/approve', async (req) => decide(req, true));
  app.post('/v1/code/runs/:id/reject', async (req) => decide(req, false));

  app.get('/v1/code/runs/:id/diff', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const { codeWorkspaceId } = await codeRunOf(p, id);
    const [patches, current] = await Promise.all([patchesRepo.listForRun(deps.pool, id), code.diffSummary(codeWorkspaceId).catch(() => null)]);
    return { patches, workingTree: current };
  });

  app.post('/v1/code/runs/:id/commit', async (req) => {
    const p = requireScope(req, Scopes.codeWrite);
    const { id } = IdParams.parse(req.params);
    return commit(req, (await codeRunOf(p, id)).codeWorkspaceId, id);
  });
  app.post('/v1/code/runs/:id/push', async (req) => {
    const p = requireScope(req, Scopes.codePublish);
    const { id } = IdParams.parse(req.params);
    return push(req, (await codeRunOf(p, id)).codeWorkspaceId, id);
  });
  app.post('/v1/code/runs/:id/pull-request', async (req) => {
    const p = requireScope(req, Scopes.codePublish);
    const { id } = IdParams.parse(req.params);
    return pullRequest(req, (await codeRunOf(p, id)).codeWorkspaceId, id);
  });

  /** Replay reads recorded history only (events + artifacts). It never re-runs anything. */
  app.get('/v1/code/runs/:id/replay', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const { run, codeRun, codeWorkspaceId } = await codeRunOf(p, id);
    const [events, patches, executions, approvals, operations, context, instruction] = await Promise.all([
      runEventsRepo.list(deps.pool, id, 0, 20_000),
      patchesRepo.listForRun(deps.pool, id),
      sandboxRepo.list(deps.pool, codeWorkspaceId, { runId: id, limit: 200 }),
      codeApprovalsRepo.listForRun(deps.pool, id),
      gitOpsRepo.list(deps.pool, codeWorkspaceId, id),
      codeRunsRepo.contextItems(deps.pool, id),
      deps.pool
        .query(`SELECT content FROM messages WHERE run_id = $1 AND role = 'user' ORDER BY position LIMIT 1`, [id])
        .then((r) => (r.rows[0]?.content as string | undefined) ?? null),
    ]);
    // Token deltas are folded into the final answer; everything else is replayed as recorded.
    const replay = events.filter((e) => e.type !== 'response.delta' && e.type !== 'command.output');
    return {
      run: publicRun(run),
      codeRun,
      request: run.request.workspaceContext,
      instruction,
      output: run.output,
      events: replay,
      patches,
      executions,
      approvals,
      operations,
      context,
    };
  });

  /** Coding evaluation signals computed from persisted execution data (PRD §56.35). */
  app.get('/v1/code/runs/:id/evaluation', async (req) => {
    const p = requireScope(req, Scopes.codeRead);
    const { id } = IdParams.parse(req.params);
    const { run, codeWorkspaceId } = await codeRunOf(p, id);
    const [executions, patches, approvals, details] = await Promise.all([
      sandboxRepo.list(deps.pool, codeWorkspaceId, { runId: id, limit: 200 }),
      patchesRepo.listForRun(deps.pool, id),
      codeApprovalsRepo.listForRun(deps.pool, id),
      executionRepo.runDetails(deps.pool, id),
    ]);
    const chronological = [...executions].reverse();
    const last = (kind: string) => chronological.filter((e) => e.kind === kind).at(-1);
    const tests = chronological.filter((e) => e.kind === 'test');
    const outcome = (e: { status: string } | undefined) => (e ? e.status === 'passed' : null);
    const regression = tests.some((t, i) => t.status === 'passed' && tests.slice(i + 1).some((later) => later.status === 'failed'));
    const signals = {
      testsPassed: outcome(last('test')),
      buildPassed: outcome(last('build')),
      lintPassed: outcome(last('lint')),
      patchesApplied: patches.filter((x) => x.status === 'applied').length,
      patchesProposed: patches.length,
      userAccepted: approvals.filter((a) => a.decision === 'approved').length,
      userRejected: approvals.filter((a) => a.decision === 'rejected').length + patches.filter((x) => x.status === 'rejected').length,
      regressionIntroduced: regression,
      taskCompleted: run.status === 'completed',
      toolErrors: details.toolCalls.filter((t) => t.status !== 'success').length,
      executionDurationMs: run.startedAt && run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null,
    };
    let score = signals.taskCompleted ? 0.4 : 0;
    if (signals.testsPassed === true) score += 0.3;
    if (signals.buildPassed !== false && signals.lintPassed !== false) score += 0.1;
    if (signals.patchesApplied > 0 && signals.userRejected === 0) score += 0.1;
    if (!signals.regressionIntroduced && signals.toolErrors === 0) score += 0.1;
    return { signals, score: Math.round(score * 100) / 100, evaluations: details.evaluations };
  });
}
