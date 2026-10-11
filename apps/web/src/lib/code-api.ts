import type {
  ApprovalMode,
  CodePatch,
  CodeRunRequestBody,
  CodeWorkspace,
  CreateCodeWorkspaceBody,
  Dataset,
  DatasetExample,
  FileChange,
  FineTuningJob,
  GitOperation,
  ModelDeployment,
  ModelEvaluation,
  ModelInfo,
  ModelLabConfig,
  ModelLabScope,
  PlanDecisionBody,
  ProviderInfo,
  RunEvent,
  SandboxExecution,
  CreateRunResponse,
  Run,
} from '@neuroflow/contracts';
import { API_BASE, ApiRequestError, type RunDetails } from './api';

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; retryable?: boolean } } | null)?.error;
    throw new ApiRequestError(res.status, err?.code ?? 'internal', err?.message ?? `Request failed (${res.status})`, err?.retryable);
  }
  return body as T;
}

export type GitHubConnection = { id: string; kind: 'oauth' | 'token'; login: string; scopes: string[]; createdAt: string; lastUsedAt: string | null };
export type GitHubOwner = { login: string; type: 'User' | 'Organization'; avatarUrl: string };
export type GitHubRepo = { owner: string; name: string; fullName: string; private: boolean; defaultBranch: string; description: string | null; permissions: { push: boolean }; updatedAt: string };
export type GitStatusEntry = { path: string; code: string; kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'; oldPath?: string };
export type TreeEntry = { path: string; status?: GitStatusEntry['kind'] };
export type SearchHit = { path: string; line: number; text: string };
export type CodeRunSummary = { runId: string; status: string; approvalMode: ApprovalMode; filesChanged: number; additions: number; deletions: number; testsPassed: boolean | null; agentBranch: string | null; finalCommit: string | null; createdAt: string; error: string | null };
export type CodeRunDetail = {
  run: Run;
  codeRun: CodeRunSummary | null;
  codeWorkspaceId: string;
  patches: CodePatch[];
  executions: SandboxExecution[];
  approvals: Array<{ subjectType: string; subjectId: string | null; decision: string; createdAt: string }>;
  operations: GitOperation[];
  context: Array<{ kind: string; path: string | null; startLine: number | null; endLine: number | null; detail: string | null }>;
  details: RunDetails['details'];
};
export type Replay = Omit<CodeRunDetail, 'details'> & { instruction: string | null; output: string | null; events: RunEvent[]; request: { activeFile?: string; approvalMode?: ApprovalMode; action?: string } | null };
export type CodingEvaluation = {
  signals: {
    testsPassed: boolean | null;
    buildPassed: boolean | null;
    lintPassed: boolean | null;
    patchesApplied: number;
    patchesProposed: number;
    userAccepted: number;
    userRejected: number;
    regressionIntroduced: boolean;
    taskCompleted: boolean;
    toolErrors: number;
    executionDurationMs: number | null;
  };
  score: number;
  evaluations: RunDetails['details']['evaluations'];
};

export const codeApi = {
  // GitHub
  githubConfig: () => request<{ oauth: boolean; tokenConnect: boolean }>('/v1/github/config'),
  connections: () => request<{ connections: GitHubConnection[] }>('/v1/github/connections').then((r) => r.connections),
  connectToken: (token: string) => request<{ connection: GitHubConnection }>('/v1/github/connections', { method: 'POST', json: { token } }),
  disconnect: (id: string) => request<void>(`/v1/github/connections/${id}`, { method: 'DELETE' }),
  oauthStart: () => request<{ url: string }>('/v1/github/oauth/start'),
  owners: (connectionId: string) => request<{ owners: GitHubOwner[] }>(`/v1/github/connections/${connectionId}/owners`).then((r) => r.owners),
  repos: (connectionId: string, owner: string) =>
    request<{ repositories: GitHubRepo[] }>(`/v1/github/connections/${connectionId}/repos?owner=${encodeURIComponent(owner)}`).then((r) => r.repositories),
  branches: (connectionId: string, owner: string, repo: string) =>
    request<{ branches: Array<{ name: string; protected: boolean }> }>(`/v1/github/connections/${connectionId}/repos/${owner}/${repo}/branches`).then((r) => r.branches),

  // Workspaces
  workspaces: () => request<{ workspaces: CodeWorkspace[] }>('/v1/code/workspaces').then((r) => r.workspaces),
  createWorkspace: (body: CreateCodeWorkspaceBody) => request<{ workspace: CodeWorkspace }>('/v1/code/workspaces', { method: 'POST', json: body }),
  workspace: (id: string) => request<{ workspace: CodeWorkspace; commands: Record<string, string>; sandboxAvailable: boolean }>(`/v1/code/workspaces/${id}`),
  updateWorkspace: (id: string, patch: { approvalMode?: ApprovalMode; commands?: Record<string, string> }) =>
    request<{ workspace: CodeWorkspace }>(`/v1/code/workspaces/${id}`, { method: 'PATCH', json: patch }),
  archiveWorkspace: (id: string) => request<void>(`/v1/code/workspaces/${id}`, { method: 'DELETE' }),
  sync: (id: string) => request<{ ok: true }>(`/v1/code/workspaces/${id}/sync`, { method: 'POST', json: {} }),
  tree: (id: string) => request<{ files: TreeEntry[]; truncated: boolean }>(`/v1/code/workspaces/${id}/tree`),
  file: (id: string, path: string) =>
    request<{ path: string; content?: string; size: number; binary: boolean }>(`/v1/code/workspaces/${id}/file?path=${encodeURIComponent(path)}`),
  fileAt: (id: string, path: string, ref: 'HEAD' | 'base') =>
    request<{ path: string; content: string | null; exists: boolean }>(`/v1/code/workspaces/${id}/file?path=${encodeURIComponent(path)}&ref=${ref}`),
  saveFile: (id: string, path: string, content: string) => request<{ saved: true }>(`/v1/code/workspaces/${id}/file`, { method: 'PUT', json: { path, content } }),
  search: (id: string, query: string, kind: 'text' | 'regex' | 'symbol' | 'references' | 'files') =>
    request<{ results: SearchHit[] }>(`/v1/code/workspaces/${id}/search`, { method: 'POST', json: { query, kind } }).then((r) => r.results),
  git: (id: string) =>
    request<{ branch: string; baseBranch: string; status: GitStatusEntry[]; branches: string[]; log: Array<{ sha: string; author: string; date: string; subject: string }>; operations: GitOperation[]; canPush: boolean }>(
      `/v1/code/workspaces/${id}/git`,
    ),
  diff: (id: string, path?: string) =>
    request<{ diff: string; files: FileChange[]; additions?: number; deletions?: number }>(`/v1/code/workspaces/${id}/diff${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  createBranch: (id: string, name: string) => request<{ branch: string; from: string }>(`/v1/code/workspaces/${id}/git/branch`, { method: 'POST', json: { name } }),
  checkout: (id: string, branch: string) => request<{ branch: string }>(`/v1/code/workspaces/${id}/git/checkout`, { method: 'POST', json: { branch } }),
  commit: (id: string, message: string, runId?: string) =>
    request<{ sha: string; branch: string; files: number }>(runId ? `/v1/code/runs/${runId}/commit` : `/v1/code/workspaces/${id}/git/commit`, { method: 'POST', json: { message } }),
  push: (id: string, runId?: string) => request<{ branch: string; sha: string; remote: string }>(runId ? `/v1/code/runs/${runId}/push` : `/v1/code/workspaces/${id}/git/push`, { method: 'POST', json: {} }),
  pullRequest: (id: string, body: { title: string; body: string; draft: boolean }, runId?: string) =>
    request<{ number: number; url: string; head: string; base: string }>(runId ? `/v1/code/runs/${runId}/pull-request` : `/v1/code/workspaces/${id}/git/pull-request`, { method: 'POST', json: body }),
  runCommand: (id: string, command: string, kind: 'command' | 'test' | 'lint' | 'build' | 'install' = 'command') =>
    request<{ correlationId: string; network: boolean }>(`/v1/code/workspaces/${id}/commands`, { method: 'POST', json: { command, kind } }),
  executions: (id: string, runId?: string) =>
    request<{ executions: SandboxExecution[] }>(`/v1/code/workspaces/${id}/executions${runId ? `?runId=${runId}` : ''}`).then((r) => r.executions),
  runs: (id: string) => request<{ runs: CodeRunSummary[] }>(`/v1/code/workspaces/${id}/runs`).then((r) => r.runs),

  // Code runs
  startRun: (body: CodeRunRequestBody, idempotencyKey: string) =>
    request<CreateRunResponse>('/v1/code/runs', { method: 'POST', json: body, headers: { 'idempotency-key': idempotencyKey } }),
  run: (runId: string) => request<CodeRunDetail>(`/v1/code/runs/${runId}`),
  approve: (runId: string, input: { patchId?: string; toolCallId?: string }) => request<{ ok: true }>(`/v1/code/runs/${runId}/approve`, { method: 'POST', json: input }),
  reject: (runId: string, input: { patchId?: string; toolCallId?: string; reason?: string }) => request<{ ok: true }>(`/v1/code/runs/${runId}/reject`, { method: 'POST', json: input }),
  cancel: (runId: string) => request<unknown>(`/v1/code/runs/${runId}/cancel`, { method: 'POST', json: {} }),
  decidePlan: (runId: string, body: PlanDecisionBody) => request<{ ok: true }>(`/v1/code/runs/${runId}/plan`, { method: 'POST', json: body }),
  replay: (runId: string) => request<Replay>(`/v1/code/runs/${runId}/replay`),
  evaluation: (runId: string) => request<CodingEvaluation>(`/v1/code/runs/${runId}/evaluation`),
};

export const labApi = {
  providers: () => request<{ providers: ProviderInfo[] }>('/v1/model-lab/providers').then((r) => r.providers),
  models: () => request<{ models: ModelInfo[]; default: string | null; deployments: ModelDeployment[] }>('/v1/model-lab/models'),
  config: (scope: ModelLabScope) => request<{ scope: ModelLabScope; config: ModelLabConfig; canEdit: boolean }>(`/v1/model-lab/configs/${scope}`),
  saveConfig: (scope: ModelLabScope, config: ModelLabConfig) => request<{ config: ModelLabConfig }>(`/v1/model-lab/configs/${scope}`, { method: 'PUT', json: config }),
  deployments: () => request<{ deployments: ModelDeployment[] }>('/v1/model-lab/deployments').then((r) => r.deployments),
  saveDeployment: (d: { name: string; model: string; parameters: ModelDeployment['parameters']; description: string; status: 'active' | 'disabled' }) =>
    request<{ deployment: ModelDeployment }>('/v1/model-lab/deployments', { method: 'POST', json: d }),
  deleteDeployment: (name: string) => request<void>(`/v1/model-lab/deployments/${name}`, { method: 'DELETE' }),
  datasets: () => request<{ datasets: Dataset[] }>('/v1/model-lab/datasets').then((r) => r.datasets),
  createDataset: (name: string, description = '') => request<{ id: string }>('/v1/model-lab/datasets', { method: 'POST', json: { name, description } }),
  dataset: (id: string) => request<{ dataset: Dataset; examples: DatasetExample[] }>(`/v1/model-lab/datasets/${id}`),
  deleteDataset: (id: string) => request<void>(`/v1/model-lab/datasets/${id}`, { method: 'DELETE' }),
  addExample: (id: string, e: { task: string; expected?: string; context?: string }) => request<unknown>(`/v1/model-lab/datasets/${id}/examples`, { method: 'POST', json: e }),
  importExamples: (id: string, jsonl: string) => request<{ imported: number; errors: string[] }>(`/v1/model-lab/datasets/${id}/import`, { method: 'POST', json: { jsonl } }),
  exampleFromRun: (id: string, runId: string, outcome: 'accepted' | 'rejected' | 'neutral') =>
    request<unknown>(`/v1/model-lab/datasets/${id}/examples/from-run`, { method: 'POST', json: { runId, outcome } }),
  reviewExample: (id: string, exampleId: string, reviewed: boolean) => request<unknown>(`/v1/model-lab/datasets/${id}/examples/${exampleId}`, { method: 'PATCH', json: { reviewed } }),
  deleteExample: (id: string, exampleId: string) => request<void>(`/v1/model-lab/datasets/${id}/examples/${exampleId}`, { method: 'DELETE' }),
  exportUrl: (id: string) => `${API_BASE}/v1/model-lab/datasets/${id}/export`,
  fineTuning: () => request<{ providers: Array<{ provider: string; displayName: string; status: string; reason: string }>; jobs: FineTuningJob[] }>('/v1/model-lab/fine-tuning'),
  evaluations: () => request<{ evaluations: ModelEvaluation[] }>('/v1/model-lab/evaluations').then((r) => r.evaluations),
  evaluation: (id: string) => request<{ evaluation: ModelEvaluation }>(`/v1/model-lab/evaluations/${id}`).then((r) => r.evaluation),
  createEvaluation: (body: { name: string; datasetId: string; models: string[]; scorer: 'contains' | 'exact' | 'judge' }) =>
    request<{ id: string }>('/v1/model-lab/evaluations', { method: 'POST', json: body }),
};
