import { z } from 'zod';

/**
 * Product Phase 2 contracts. A code run is an ordinary NeuroFlow run that carries a
 * `workspaceContext`; repository, file, Git and sandbox operations are Tool Runtime capabilities.
 *
 * Naming: the Phase 1 `workspace` is the tenant (isolation) unit. A *code workspace* is a
 * repository checkout on a branch, owned by a tenant workspace.
 */

/** Suggest = propose only · Review = hold for approval · Auto = low-risk within policy · Restricted = read-only. */
export const ApprovalMode = z.enum(['suggest', 'review', 'auto', 'restricted']);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

export const LineRange = z
  .object({ start: z.number().int().min(1), end: z.number().int().min(1) })
  .refine((r) => r.end >= r.start, 'end must be >= start');
export type LineRange = z.infer<typeof LineRange>;

/** Optional repository context of a run (system design §2 `workspaceContext`). */
export const WorkspaceContext = z.object({
  codeWorkspaceId: z.string().uuid(),
  activeFile: z.string().max(500).optional(),
  selectedLines: LineRange.optional(),
  /** Extra files the user pinned as context. */
  relatedFiles: z.array(z.string().max(500)).max(20).optional(),
  approvalMode: ApprovalMode.default('review'),
  /** Structured context action (Explain, Fix, …) that produced this request, if any. */
  action: z.enum(['ask', 'explain', 'fix', 'refactor', 'optimize', 'write_tests', 'find_bug', 'find_security_issue', 'document', 'search']).optional(),
});
export type WorkspaceContext = z.infer<typeof WorkspaceContext>;
export type WorkspaceContextInput = z.input<typeof WorkspaceContext>;

export const FileChange = z.object({
  path: z.string(),
  op: z.enum(['create', 'modify', 'delete', 'rename']),
  oldPath: z.string().optional(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type FileChange = z.infer<typeof FileChange>;

export const CodeWorkspaceStatus = z.enum(['provisioning', 'ready', 'syncing', 'error', 'archived']);
export type CodeWorkspaceStatus = z.infer<typeof CodeWorkspaceStatus>;

export const RepositoryBinding = z.object({
  id: z.string().uuid(),
  provider: z.enum(['github', 'local']),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  htmlUrl: z.string().nullable(),
  /** Whether the connected credentials may push (repository access ≠ modification permission). */
  canPush: z.boolean(),
});
export type RepositoryBinding = z.infer<typeof RepositoryBinding>;

export const CodeWorkspace = z.object({
  id: z.string().uuid(),
  repository: RepositoryBinding,
  branch: z.string(),
  baseBranch: z.string(),
  /** Commit the workspace was created from (starting commit). */
  baseCommit: z.string().nullable(),
  /** Current HEAD of the checkout. */
  headCommit: z.string().nullable(),
  status: CodeWorkspaceStatus,
  error: z.string().nullable(),
  approvalMode: ApprovalMode,
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CodeWorkspace = z.infer<typeof CodeWorkspace>;

export const PatchStatus = z.enum(['proposed', 'review_required', 'approved', 'rejected', 'applied', 'failed', 'superseded']);
export type PatchStatus = z.infer<typeof PatchStatus>;

export const CodePatch = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  codeWorkspaceId: z.string().uuid(),
  toolCallId: z.string().nullable(),
  baseCommit: z.string().nullable(),
  files: z.array(FileChange),
  diff: z.string(),
  summary: z.string().nullable(),
  validation: z.enum(['valid', 'invalid']),
  validationError: z.string().nullable(),
  status: PatchStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type CodePatch = z.infer<typeof CodePatch>;

export const SandboxExecution = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  codeWorkspaceId: z.string().uuid(),
  kind: z.enum(['command', 'test', 'lint', 'build', 'install']),
  command: z.string(),
  status: z.enum(['running', 'passed', 'failed', 'timeout', 'cancelled', 'denied']),
  exitCode: z.number().int().nullable(),
  output: z.string(),
  truncated: z.boolean(),
  durationMs: z.number().int().nullable(),
  triggeredBy: z.enum(['agent', 'user']),
  createdAt: z.string(),
});
export type SandboxExecution = z.infer<typeof SandboxExecution>;

export const GitOperation = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  kind: z.enum(['branch', 'commit', 'push', 'pull_request']),
  ref: z.string().nullable(),
  sha: z.string().nullable(),
  url: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.string(),
});
export type GitOperation = z.infer<typeof GitOperation>;

// ---- API bodies ----

export const ConnectGitHubTokenBody = z.object({ token: z.string().trim().min(20).max(400) });

export const CreateCodeWorkspaceBody = z.union([
  z.object({
    provider: z.literal('github'),
    connectionId: z.string().uuid(),
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    branch: z.string().min(1).max(250).optional(),
    approvalMode: ApprovalMode.default('review'),
  }),
  z.object({
    /** Local repositories are a development convenience (AUTH_MODE=dev only). */
    provider: z.literal('local'),
    path: z.string().min(1).max(1000),
    branch: z.string().min(1).max(250).optional(),
    approvalMode: ApprovalMode.default('review'),
  }),
]);
export type CreateCodeWorkspaceBody = z.input<typeof CreateCodeWorkspaceBody>;

export const SaveFileBody = z.object({ path: z.string().min(1).max(500), content: z.string().max(1024 * 1024) });

export const CodeSearchBody = z.object({
  query: z.string().min(1).max(300),
  kind: z.enum(['text', 'regex', 'symbol', 'references', 'files']).default('text'),
  paths: z.array(z.string()).max(10).optional(),
  caseSensitive: z.boolean().default(false),
});

export const RunCommandBody = z.object({
  command: z.string().min(1).max(2000),
  kind: z.enum(['command', 'test', 'lint', 'build', 'install']).default('command'),
});

export const CommitBody = z.object({ message: z.string().trim().min(3).max(2000) });

export const CreatePullRequestBody = z.object({
  title: z.string().trim().min(3).max(250),
  body: z.string().max(60_000).default(''),
  draft: z.boolean().default(true),
});

export const CodeRunRequestBody = z.object({
  codeWorkspaceId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(32_000),
  activeFile: z.string().max(500).optional(),
  selection: z.object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).optional(),
  context: z.array(z.string().max(500)).max(20).optional(),
  approvalMode: ApprovalMode.optional(),
  action: WorkspaceContext.shape.action,
  conversationId: z.string().uuid().optional(),
  selectedModel: z.string().optional(),
  reasoningBudget: z.enum(['off', 'low', 'medium', 'high']).optional(),
  mode: z.enum(['standard', 'cognitive']).default('standard'),
});
export type CodeRunRequestBody = z.input<typeof CodeRunRequestBody>;

export const PatchDecisionBody = z.object({ patchId: z.string().uuid().optional(), toolCallId: z.string().optional(), reason: z.string().max(500).optional() });
