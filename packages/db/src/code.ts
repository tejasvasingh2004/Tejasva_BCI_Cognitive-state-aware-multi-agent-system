import type {
  ApprovalMode,
  CodePatch,
  CodeWorkspace,
  CodeWorkspaceStatus,
  FileChange,
  GitOperation,
  PatchStatus,
  RepositoryBinding,
  SandboxExecution,
} from '@neuroflow/contracts';
import { iso, type Queryable } from './client';

// ---------------------------------------------------------------- GitHub connections

export type GitHubConnectionRow = {
  id: string;
  workspaceId: string;
  userId: string;
  kind: 'oauth' | 'token';
  githubLogin: string;
  scopes: string[];
  tokenEncrypted: string;
  createdAt: string;
  lastUsedAt: string | null;
};

const toConnection = (r: Record<string, unknown>): GitHubConnectionRow => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  userId: r.user_id as string,
  kind: r.kind as GitHubConnectionRow['kind'],
  githubLogin: r.github_login as string,
  scopes: (r.scopes as string[]) ?? [],
  tokenEncrypted: r.token_encrypted as string,
  createdAt: iso(r.created_at as Date)!,
  lastUsedAt: iso((r.last_used_at as Date | null) ?? null),
});

export const githubRepo = {
  async create(
    db: Queryable,
    input: { workspaceId: string; userId: string; kind: 'oauth' | 'token'; githubLogin: string; githubUserId?: number; tokenEncrypted: string; scopes: string[] },
  ): Promise<GitHubConnectionRow> {
    // One active connection per user + GitHub account in a workspace: reconnecting replaces it.
    await db.query(
      `UPDATE github_connections SET revoked_at = now()
        WHERE workspace_id = $1 AND user_id = $2 AND github_login = $3 AND revoked_at IS NULL`,
      [input.workspaceId, input.userId, input.githubLogin],
    );
    const { rows } = await db.query(
      `INSERT INTO github_connections (workspace_id, user_id, kind, github_login, github_user_id, token_encrypted, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [input.workspaceId, input.userId, input.kind, input.githubLogin, input.githubUserId ?? null, input.tokenEncrypted, input.scopes],
    );
    return toConnection(rows[0]);
  },

  /** Connections are personal: a user can only use their own credentials. */
  async get(db: Queryable, id: string, workspaceId: string, userId: string): Promise<GitHubConnectionRow | null> {
    const { rows } = await db.query(
      'SELECT * FROM github_connections WHERE id = $1 AND workspace_id = $2 AND user_id = $3 AND revoked_at IS NULL',
      [id, workspaceId, userId],
    );
    return rows[0] ? toConnection(rows[0]) : null;
  },

  /** For the worker: resolve by id within a workspace (the run's principal was already authorized). */
  async getById(db: Queryable, id: string, workspaceId: string): Promise<GitHubConnectionRow | null> {
    const { rows } = await db.query('SELECT * FROM github_connections WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL', [id, workspaceId]);
    return rows[0] ? toConnection(rows[0]) : null;
  },

  async list(db: Queryable, workspaceId: string, userId: string): Promise<GitHubConnectionRow[]> {
    const { rows } = await db.query(
      'SELECT * FROM github_connections WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC',
      [workspaceId, userId],
    );
    return rows.map(toConnection);
  },

  async touch(db: Queryable, id: string): Promise<void> {
    await db.query('UPDATE github_connections SET last_used_at = now() WHERE id = $1', [id]);
  },

  async revoke(db: Queryable, id: string, workspaceId: string, userId: string): Promise<boolean> {
    const res = await db.query(
      'UPDATE github_connections SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND user_id = $3 AND revoked_at IS NULL',
      [id, workspaceId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  },
};

// ---------------------------------------------------------------- repositories & code workspaces

export type RepositoryRow = RepositoryBinding & { workspaceId: string; connectionId: string | null; cloneUrl: string };

const toRepository = (r: Record<string, unknown>): RepositoryRow => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  connectionId: (r.connection_id as string | null) ?? null,
  provider: r.provider as RepositoryBinding['provider'],
  owner: r.owner as string,
  name: r.name as string,
  fullName: `${r.owner as string}/${r.name as string}`,
  defaultBranch: r.default_branch as string,
  private: r.private as boolean,
  htmlUrl: (r.html_url as string | null) ?? null,
  canPush: r.can_push as boolean,
  cloneUrl: r.clone_url as string,
});

export type CodeWorkspaceRow = CodeWorkspace & {
  workspaceId: string;
  createdBy: string;
  repository: RepositoryRow;
  commands: Record<string, string>;
};

const toCodeWorkspace = (r: Record<string, unknown>, repo: RepositoryRow): CodeWorkspaceRow => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  createdBy: r.created_by as string,
  repository: repo,
  branch: r.branch as string,
  baseBranch: r.base_branch as string,
  baseCommit: (r.base_commit as string | null) ?? null,
  headCommit: (r.head_commit as string | null) ?? null,
  status: r.status as CodeWorkspaceStatus,
  error: (r.error as string | null) ?? null,
  approvalMode: r.approval_mode as ApprovalMode,
  commands: (r.commands as Record<string, string>) ?? {},
  lastSyncedAt: iso((r.last_synced_at as Date | null) ?? null),
  createdAt: iso(r.created_at as Date)!,
});

const CW_SELECT = `SELECT cw.*, row_to_json(rb.*) AS repo FROM code_workspaces cw JOIN repository_bindings rb ON rb.id = cw.repository_id`;
const fromJoined = (r: Record<string, unknown>) => {
  const repo = r.repo as Record<string, unknown>;
  return toCodeWorkspace(r, toRepository({ ...repo, created_at: repo.created_at }));
};

export const codeWorkspacesRepo = {
  async upsertRepository(
    db: Queryable,
    input: {
      workspaceId: string;
      connectionId: string | null;
      provider: 'github' | 'local';
      owner: string;
      name: string;
      defaultBranch: string;
      cloneUrl: string;
      htmlUrl: string | null;
      private: boolean;
      canPush: boolean;
    },
  ): Promise<RepositoryRow> {
    const { rows } = await db.query(
      `INSERT INTO repository_bindings (workspace_id, connection_id, provider, owner, name, default_branch, clone_url, html_url, private, can_push)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (workspace_id, provider, owner, name) DO UPDATE SET
         connection_id = EXCLUDED.connection_id, default_branch = EXCLUDED.default_branch, clone_url = EXCLUDED.clone_url,
         html_url = EXCLUDED.html_url, private = EXCLUDED.private, can_push = EXCLUDED.can_push
       RETURNING *`,
      [input.workspaceId, input.connectionId, input.provider, input.owner, input.name, input.defaultBranch, input.cloneUrl, input.htmlUrl, input.private, input.canPush],
    );
    return toRepository(rows[0]);
  },

  async create(
    db: Queryable,
    input: { workspaceId: string; repositoryId: string; createdBy: string; branch: string; baseBranch: string; approvalMode: ApprovalMode },
  ): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO code_workspaces (workspace_id, repository_id, created_by, branch, base_branch, status, approval_mode)
       VALUES ($1, $2, $3, $4, $5, 'provisioning', $6) RETURNING id`,
      [input.workspaceId, input.repositoryId, input.createdBy, input.branch, input.baseBranch, input.approvalMode],
    );
    return rows[0].id;
  },

  async get(db: Queryable, id: string, workspaceId?: string): Promise<CodeWorkspaceRow | null> {
    const { rows } = workspaceId
      ? await db.query(`${CW_SELECT} WHERE cw.id = $1 AND cw.workspace_id = $2`, [id, workspaceId])
      : await db.query(`${CW_SELECT} WHERE cw.id = $1`, [id]);
    return rows[0] ? fromJoined(rows[0]) : null;
  },

  async list(db: Queryable, workspaceId: string): Promise<CodeWorkspaceRow[]> {
    const { rows } = await db.query(`${CW_SELECT} WHERE cw.workspace_id = $1 AND cw.status <> 'archived' ORDER BY cw.updated_at DESC LIMIT 100`, [workspaceId]);
    return rows.map(fromJoined);
  },

  async setStatus(db: Queryable, id: string, status: CodeWorkspaceStatus, error: string | null = null): Promise<void> {
    await db.query('UPDATE code_workspaces SET status = $2, error = $3, updated_at = now() WHERE id = $1', [id, status, error]);
  },

  async markSynced(db: Queryable, id: string, input: { headCommit: string; baseCommit?: string; branch?: string; commands?: Record<string, string> }): Promise<void> {
    await db.query(
      `UPDATE code_workspaces SET status = 'ready', error = NULL, head_commit = $2, base_commit = COALESCE(base_commit, $3),
              branch = COALESCE($4, branch), commands = COALESCE($5, commands), last_synced_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, input.headCommit, input.baseCommit ?? input.headCommit, input.branch ?? null, input.commands ? JSON.stringify(input.commands) : null],
    );
  },

  async setHead(db: Queryable, id: string, headCommit: string, branch?: string): Promise<void> {
    await db.query('UPDATE code_workspaces SET head_commit = $2, branch = COALESCE($3, branch), updated_at = now() WHERE id = $1', [id, headCommit, branch ?? null]);
  },

  async setApprovalMode(db: Queryable, id: string, workspaceId: string, mode: ApprovalMode): Promise<boolean> {
    const res = await db.query('UPDATE code_workspaces SET approval_mode = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2', [id, workspaceId, mode]);
    return (res.rowCount ?? 0) > 0;
  },

  async archive(db: Queryable, id: string, workspaceId: string): Promise<boolean> {
    const res = await db.query(`UPDATE code_workspaces SET status = 'archived', updated_at = now() WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
    return (res.rowCount ?? 0) > 0;
  },
};

// ---------------------------------------------------------------- code runs & context

export type CodeRunRow = {
  runId: string;
  codeWorkspaceId: string;
  approvalMode: ApprovalMode;
  baseCommit: string | null;
  agentBranch: string | null;
  finalCommit: string | null;
  filesChanged: number;
  additions: number;
  deletions: number;
  testsPassed: boolean | null;
  createdAt: string;
};

const toCodeRun = (r: Record<string, unknown>): CodeRunRow => ({
  runId: r.run_id as string,
  codeWorkspaceId: r.code_workspace_id as string,
  approvalMode: r.approval_mode as ApprovalMode,
  baseCommit: (r.base_commit as string | null) ?? null,
  agentBranch: (r.agent_branch as string | null) ?? null,
  finalCommit: (r.final_commit as string | null) ?? null,
  filesChanged: r.files_changed as number,
  additions: r.additions as number,
  deletions: r.deletions as number,
  testsPassed: (r.tests_passed as boolean | null) ?? null,
  createdAt: iso(r.created_at as Date)!,
});

export const codeRunsRepo = {
  async create(db: Queryable, input: { runId: string; codeWorkspaceId: string; approvalMode: ApprovalMode; baseCommit: string | null }): Promise<void> {
    await db.query(
      `INSERT INTO code_runs (run_id, code_workspace_id, approval_mode, base_commit) VALUES ($1, $2, $3, $4) ON CONFLICT (run_id) DO NOTHING`,
      [input.runId, input.codeWorkspaceId, input.approvalMode, input.baseCommit],
    );
  },
  async get(db: Queryable, runId: string): Promise<CodeRunRow | null> {
    const { rows } = await db.query('SELECT * FROM code_runs WHERE run_id = $1', [runId]);
    return rows[0] ? toCodeRun(rows[0]) : null;
  },
  async listForWorkspace(db: Queryable, codeWorkspaceId: string, limit = 50) {
    const { rows } = await db.query(
      `SELECT c.*, r.status, r.request_options, r.output, r.error_message, r.created_at AS run_created_at
         FROM code_runs c JOIN runs r ON r.id = c.run_id
        WHERE c.code_workspace_id = $1 ORDER BY c.created_at DESC LIMIT $2`,
      [codeWorkspaceId, limit],
    );
    return rows.map((r) => ({ ...toCodeRun(r), status: r.status as string, error: (r.error_message as string | null) ?? null }));
  },
  async update(db: Queryable, runId: string, patch: Partial<Pick<CodeRunRow, 'agentBranch' | 'finalCommit' | 'filesChanged' | 'additions' | 'deletions' | 'testsPassed'>>): Promise<void> {
    await db.query(
      `UPDATE code_runs SET
         agent_branch = COALESCE($2, agent_branch), final_commit = COALESCE($3, final_commit),
         files_changed = COALESCE($4, files_changed), additions = COALESCE($5, additions), deletions = COALESCE($6, deletions),
         tests_passed = COALESCE($7, tests_passed)
       WHERE run_id = $1`,
      [runId, patch.agentBranch ?? null, patch.finalCommit ?? null, patch.filesChanged ?? null, patch.additions ?? null, patch.deletions ?? null, patch.testsPassed ?? null],
    );
  },
  async addContext(
    db: Queryable,
    runId: string,
    item: { kind: string; path?: string; startLine?: number; endLine?: number; detail?: string },
  ): Promise<void> {
    await db.query(
      'INSERT INTO code_context_items (run_id, kind, path, start_line, end_line, detail) VALUES ($1, $2, $3, $4, $5, $6)',
      [runId, item.kind, item.path ?? null, item.startLine ?? null, item.endLine ?? null, item.detail?.slice(0, 500) ?? null],
    );
  },
  async contextItems(db: Queryable, runId: string) {
    const { rows } = await db.query('SELECT kind, path, start_line, end_line, detail FROM code_context_items WHERE run_id = $1 ORDER BY created_at', [runId]);
    return rows.map((r) => ({ kind: r.kind as string, path: r.path as string | null, startLine: r.start_line as number | null, endLine: r.end_line as number | null, detail: r.detail as string | null }));
  },
};

// ---------------------------------------------------------------- patches & approvals

const toPatch = (r: Record<string, unknown>): CodePatch => ({
  id: r.id as string,
  runId: (r.run_id as string | null) ?? null,
  codeWorkspaceId: r.code_workspace_id as string,
  toolCallId: (r.tool_call_id as string | null) ?? null,
  baseCommit: (r.base_commit as string | null) ?? null,
  files: r.files as FileChange[],
  diff: r.diff as string,
  summary: (r.summary as string | null) ?? null,
  validation: r.validation as CodePatch['validation'],
  validationError: (r.validation_error as string | null) ?? null,
  status: r.status as PatchStatus,
  createdAt: iso(r.created_at as Date)!,
  decidedAt: iso((r.decided_at as Date | null) ?? null),
});

export const patchesRepo = {
  async create(
    db: Queryable,
    input: {
      workspaceId: string;
      codeWorkspaceId: string;
      runId: string | null;
      toolCallId: string | null;
      baseCommit: string | null;
      files: FileChange[];
      diff: string;
      summary?: string;
      validation: 'valid' | 'invalid';
      validationError?: string;
      status: PatchStatus;
    },
  ): Promise<CodePatch> {
    const { rows } = await db.query(
      `INSERT INTO code_patches (workspace_id, code_workspace_id, run_id, tool_call_id, base_commit, files, diff, summary, validation, validation_error, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        input.workspaceId,
        input.codeWorkspaceId,
        input.runId,
        input.toolCallId,
        input.baseCommit,
        JSON.stringify(input.files),
        input.diff,
        input.summary ?? null,
        input.validation,
        input.validationError ?? null,
        input.status,
      ],
    );
    return toPatch(rows[0]);
  },
  async get(db: Queryable, id: string, workspaceId?: string): Promise<CodePatch | null> {
    const { rows } = workspaceId
      ? await db.query('SELECT * FROM code_patches WHERE id = $1 AND workspace_id = $2', [id, workspaceId])
      : await db.query('SELECT * FROM code_patches WHERE id = $1', [id]);
    return rows[0] ? toPatch(rows[0]) : null;
  },
  async findByToolCall(db: Queryable, runId: string, toolCallId: string): Promise<CodePatch | null> {
    const { rows } = await db.query('SELECT * FROM code_patches WHERE run_id = $1 AND tool_call_id = $2 ORDER BY created_at DESC LIMIT 1', [runId, toolCallId]);
    return rows[0] ? toPatch(rows[0]) : null;
  },
  async listForRun(db: Queryable, runId: string): Promise<CodePatch[]> {
    const { rows } = await db.query('SELECT * FROM code_patches WHERE run_id = $1 ORDER BY created_at', [runId]);
    return rows.map(toPatch);
  },
  async setStatus(db: Queryable, id: string, status: PatchStatus): Promise<void> {
    await db.query(
      `UPDATE code_patches SET status = $2,
         decided_at = CASE WHEN $2 IN ('approved', 'rejected') THEN now() ELSE decided_at END,
         applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END
       WHERE id = $1`,
      [id, status],
    );
  },
};

export const codeApprovalsRepo = {
  async record(
    db: Queryable,
    input: {
      workspaceId: string;
      runId: string | null;
      subjectType: 'patch' | 'command' | 'delete' | 'commit' | 'push' | 'pull_request' | 'other';
      subjectId?: string;
      toolCallId?: string;
      decision: 'approved' | 'rejected';
      decidedBy: string | null;
      reason?: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO code_approvals (workspace_id, run_id, subject_type, subject_id, tool_call_id, decision, decided_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.workspaceId, input.runId, input.subjectType, input.subjectId ?? null, input.toolCallId ?? null, input.decision, input.decidedBy, input.reason ?? null],
    );
  },
  async listForRun(db: Queryable, runId: string) {
    const { rows } = await db.query('SELECT subject_type, subject_id, tool_call_id, decision, decided_by, reason, created_at FROM code_approvals WHERE run_id = $1 ORDER BY created_at', [runId]);
    return rows.map((r) => ({
      subjectType: r.subject_type as string,
      subjectId: r.subject_id as string | null,
      toolCallId: r.tool_call_id as string | null,
      decision: r.decision as string,
      decidedBy: r.decided_by as string | null,
      reason: r.reason as string | null,
      createdAt: iso(r.created_at as Date)!,
    }));
  },
};

// ---------------------------------------------------------------- sandbox, tests, git, PRs

const toExecution = (r: Record<string, unknown>): SandboxExecution => ({
  id: r.id as string,
  runId: (r.run_id as string | null) ?? null,
  codeWorkspaceId: r.code_workspace_id as string,
  kind: r.kind as SandboxExecution['kind'],
  command: r.command as string,
  status: r.status as SandboxExecution['status'],
  exitCode: (r.exit_code as number | null) ?? null,
  output: r.output as string,
  truncated: r.truncated as boolean,
  durationMs: (r.duration_ms as number | null) ?? null,
  triggeredBy: r.triggered_by as SandboxExecution['triggeredBy'],
  createdAt: iso(r.created_at as Date)!,
});

export const sandboxRepo = {
  async start(
    db: Queryable,
    input: { workspaceId: string; codeWorkspaceId: string; runId: string | null; kind: SandboxExecution['kind']; command: string; image: string; network: string; triggeredBy: 'agent' | 'user' },
  ): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO sandbox_executions (workspace_id, code_workspace_id, run_id, kind, command, image, network, status, triggered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8) RETURNING id`,
      [input.workspaceId, input.codeWorkspaceId, input.runId, input.kind, input.command, input.image, input.network, input.triggeredBy],
    );
    return rows[0].id;
  },
  async denied(
    db: Queryable,
    input: { workspaceId: string; codeWorkspaceId: string; runId: string | null; kind: SandboxExecution['kind']; command: string; reason: string; triggeredBy: 'agent' | 'user' },
  ): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO sandbox_executions (workspace_id, code_workspace_id, run_id, kind, command, status, output, triggered_by, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'denied', $6, $7, now()) RETURNING id`,
      [input.workspaceId, input.codeWorkspaceId, input.runId, input.kind, input.command, input.reason, input.triggeredBy],
    );
    return rows[0].id;
  },
  async finish(
    db: Queryable,
    id: string,
    input: { status: SandboxExecution['status']; exitCode: number | null; output: string; truncated: boolean; durationMs: number },
  ): Promise<void> {
    await db.query(
      `UPDATE sandbox_executions SET status = $2, exit_code = $3, output = $4, truncated = $5, duration_ms = $6, completed_at = now() WHERE id = $1`,
      [id, input.status, input.exitCode, input.output, input.truncated, Math.round(input.durationMs)],
    );
  },
  async recordTest(db: Queryable, input: { executionId: string; runId: string | null; passed: boolean; passedCount?: number; failedCount?: number; total?: number }) {
    await db.query(
      `INSERT INTO test_executions (sandbox_execution_id, run_id, passed, passed_count, failed_count, total_count) VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.executionId, input.runId, input.passed, input.passedCount ?? null, input.failedCount ?? null, input.total ?? null],
    );
  },
  async list(db: Queryable, codeWorkspaceId: string, opts: { runId?: string; limit?: number } = {}): Promise<SandboxExecution[]> {
    const { rows } = await db.query(
      `SELECT * FROM sandbox_executions WHERE code_workspace_id = $1 AND ($2::uuid IS NULL OR run_id = $2)
        ORDER BY created_at DESC LIMIT $3`,
      [codeWorkspaceId, opts.runId ?? null, Math.min(opts.limit ?? 50, 200)],
    );
    return rows.map(toExecution);
  },
  async get(db: Queryable, id: string): Promise<SandboxExecution | null> {
    const { rows } = await db.query('SELECT * FROM sandbox_executions WHERE id = $1', [id]);
    return rows[0] ? toExecution(rows[0]) : null;
  },
};

export const gitOpsRepo = {
  async record(
    db: Queryable,
    input: { workspaceId: string; codeWorkspaceId: string; runId: string | null; kind: GitOperation['kind']; ref?: string; sha?: string; url?: string; message?: string; performedBy?: string | null },
  ): Promise<void> {
    await db.query(
      `INSERT INTO git_operations (workspace_id, code_workspace_id, run_id, kind, ref, sha, url, message, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [input.workspaceId, input.codeWorkspaceId, input.runId, input.kind, input.ref ?? null, input.sha ?? null, input.url ?? null, input.message ?? null, input.performedBy ?? null],
    );
  },
  async list(db: Queryable, codeWorkspaceId: string, runId?: string): Promise<GitOperation[]> {
    const { rows } = await db.query(
      `SELECT * FROM git_operations WHERE code_workspace_id = $1 AND ($2::uuid IS NULL OR run_id = $2) ORDER BY created_at DESC LIMIT 100`,
      [codeWorkspaceId, runId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id ?? null,
      kind: r.kind,
      ref: r.ref ?? null,
      sha: r.sha ?? null,
      url: r.url ?? null,
      message: r.message ?? null,
      createdAt: iso(r.created_at)!,
    }));
  },
  async recordPullRequest(
    db: Queryable,
    input: { workspaceId: string; codeWorkspaceId: string; runId: string | null; number: number; url: string; title: string; head: string; base: string },
  ): Promise<void> {
    await db.query(
      `INSERT INTO pull_request_refs (workspace_id, code_workspace_id, run_id, number, url, title, head, base) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.workspaceId, input.codeWorkspaceId, input.runId, input.number, input.url, input.title, input.head, input.base],
    );
  },
};
