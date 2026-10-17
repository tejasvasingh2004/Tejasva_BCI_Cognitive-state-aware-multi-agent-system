import type { ApprovalMode, FileChange, PatchStatus, SandboxExecution, WorkspaceContext } from '@neuroflow/contracts';
import { ToolExecutionError, type ToolContext } from '@neuroflow/tools';
import type { GitAuth } from './git';
import type { GitHubClient } from './github';
import type { Sandbox } from './sandbox';
import type { RepoCheckout } from './workspace';

/** What the Code Agent tools know about the code workspace a run operates on. */
export type OpenCodeWorkspace = {
  id: string;
  workspaceId: string;
  repository: {
    id: string;
    provider: 'github' | 'local';
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string;
    canPush: boolean;
  };
  /** Branch the workspace was created from (never pushed to by the agent). */
  baseBranch: string;
  baseCommit: string | null;
  /** Workspace-level command overrides (test/lint/build/install). */
  commands: Record<string, string>;
  /** Sandbox image override from Workspace Settings (otherwise detected from the project). */
  sandboxImage?: string;
  checkout: RepoCheckout;
  /** GitHub API client with the connection's token, when the repository is on GitHub. */
  github(): Promise<GitHubClient | null>;
  /** Credentials for git push/fetch (never exposed to the model or the sandbox). */
  gitAuth(): Promise<GitAuth | undefined>;
};

/** Persistence port for code artifacts (implemented with PostgreSQL by the worker). */
export interface CodeStore {
  createPatch(input: {
    workspaceId: string;
    codeWorkspaceId: string;
    runId: string;
    toolCallId: string;
    baseCommit: string | null;
    files: FileChange[];
    diff: string;
    summary?: string;
    validation: 'valid' | 'invalid';
    validationError?: string;
    status: PatchStatus;
  }): Promise<{ id: string }>;
  setPatchStatus(id: string, status: PatchStatus): Promise<void>;
  startExecution(input: {
    workspaceId: string;
    codeWorkspaceId: string;
    runId: string | null;
    kind: SandboxExecution['kind'];
    command: string;
    image: string;
    network: string;
    triggeredBy: 'agent' | 'user';
  }): Promise<string>;
  denyExecution(input: {
    workspaceId: string;
    codeWorkspaceId: string;
    runId: string | null;
    kind: SandboxExecution['kind'];
    command: string;
    reason: string;
    triggeredBy: 'agent' | 'user';
  }): Promise<string>;
  finishExecution(
    id: string,
    input: { status: SandboxExecution['status']; exitCode: number | null; output: string; truncated: boolean; durationMs: number },
  ): Promise<void>;
  recordTest(input: { executionId: string; runId: string | null; passed: boolean; passedCount?: number; failedCount?: number; total?: number }): Promise<void>;
  recordGitOperation(input: {
    workspaceId: string;
    codeWorkspaceId: string;
    runId: string | null;
    kind: 'branch' | 'commit' | 'push' | 'pull_request';
    ref?: string;
    sha?: string;
    url?: string;
    message?: string;
    performedBy?: string | null;
  }): Promise<void>;
  recordPullRequest(input: {
    workspaceId: string;
    codeWorkspaceId: string;
    runId: string | null;
    number: number;
    url: string;
    title: string;
    head: string;
    base: string;
  }): Promise<void>;
  addContext(runId: string, item: { kind: string; path?: string; startLine?: number; endLine?: number; detail?: string }): Promise<void>;
  updateCodeRun(
    runId: string,
    patch: { agentBranch?: string; finalCommit?: string; filesChanged?: number; additions?: number; deletions?: number; testsPassed?: boolean },
  ): Promise<void>;
  setHead(codeWorkspaceId: string, headCommit: string, branch?: string): Promise<void>;
  /** Latest test result of this run, used in commit previews and evaluation. */
  lastTest(runId: string): Promise<{ passed: boolean; command: string } | null>;
}

export type CodeServices = {
  open(input: { workspaceId: string; codeWorkspaceId: string }): Promise<OpenCodeWorkspace>;
  store: CodeStore;
  sandbox: Sandbox;
};

export type CodeToolContext = ToolContext & { workspaceContext: WorkspaceContext };

/** Tools only operate inside a code run; the code workspace must belong to the run's tenant. */
export async function openFor(services: CodeServices, ctx: ToolContext): Promise<{ ws: OpenCodeWorkspace; mode: ApprovalMode; wc: WorkspaceContext }> {
  const wc = ctx.workspaceContext;
  if (!wc) throw new ToolExecutionError('This tool is only available in a code workspace run');
  const ws = await services.open({ workspaceId: ctx.workspaceId, codeWorkspaceId: wc.codeWorkspaceId });
  return { ws, mode: wc.approvalMode, wc };
}

/** Throws for modes that forbid an action class (restricted: read-only; suggest: no mutation). */
export function assertModeAllows(mode: ApprovalMode, action: 'mutate' | 'execute' | 'git_local' | 'publish') {
  if (mode === 'restricted') {
    throw new ToolExecutionError('Restricted mode is read-only: editing, command execution and Git operations are unavailable');
  }
  if (mode === 'suggest' && (action === 'git_local' || action === 'publish')) {
    throw new ToolExecutionError('Suggest mode only proposes changes; Git operations are not performed');
  }
}
