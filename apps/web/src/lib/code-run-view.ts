import type { FileChange, RunEvent, RunEventOf } from '@neuroflow/contracts';
import { TOOL_LABEL } from './run-view';

export type ActivityStatus = 'active' | 'done' | 'failed' | 'waiting';

export type CodeActivity = {
  key: string;
  seq: number;
  ts: string;
  kind: 'repo' | 'plan' | 'search' | 'read' | 'patch' | 'file' | 'command' | 'test' | 'git' | 'approval' | 'tool' | 'evaluation' | 'run';
  title: string;
  detail?: string;
  path?: string;
  status: ActivityStatus;
};

export type PatchReview = {
  patchId: string;
  toolCallId: string;
  files: FileChange[];
  diff: string;
  status: 'pending' | 'approved' | 'rejected';
  reason?: string;
};

/** An approval for something other than a patch (command, push, PR, deletion …). */
export type ActionApproval = {
  toolCallId: string;
  name: string;
  riskLevel: string;
  reason?: string;
  preview?: unknown;
  arguments: unknown;
  expiresAt: string;
};

export type CommandRecord = {
  executionId: string;
  command: string;
  kind: string;
  output: string;
  status: 'running' | 'passed' | 'failed' | 'timeout';
  exitCode?: number;
  durationMs?: number;
  startedAt: string;
};

export type TestRecord = {
  executionId: string;
  command: string;
  passed?: boolean;
  summary?: { passed?: number; failed?: number; total?: number };
  durationMs?: number;
};

export type PlanReview = { planId: string; steps: string[]; summary?: string; revision: number; expiresAt: string };

export type CodeRunView = {
  repository?: RunEventOf<'repository.loaded'>['data'];
  plan?: { steps: string[]; summary?: string; approved?: boolean };
  /** A plan waiting for the user's decision (Plan Review). */
  pendingPlan?: PlanReview;
  activity: CodeActivity[];
  reviews: PatchReview[];
  approvals: ActionApproval[];
  commands: CommandRecord[];
  tests: TestRecord[];
  diff?: { files: FileChange[]; additions: number; deletions: number };
  filesRead: string[];
  filesModified: string[];
  completed?: RunEventOf<'code.run.completed'>['data'];
  lastSeq: number;
};

export const emptyCodeRunView = (): CodeRunView => ({
  activity: [],
  reviews: [],
  approvals: [],
  commands: [],
  tests: [],
  filesRead: [],
  filesModified: [],
  lastSeq: 0,
});

const OUTPUT_LIMIT = 200_000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('ch') ? 'es' : 's'}`;
const changeStat = (files: FileChange[]) => {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return `${plural(files.length, 'file')} · +${add} −${del}`;
};
const seconds = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * Pure reducer from a code run's recorded events to the Code Agent panel state (plan, activity,
 * reviews, terminal output, tests, diff). Like the run view, it only reflects real backend events.
 */
export function applyCodeEvent(view: CodeRunView, e: RunEvent): CodeRunView {
  if (e.seq <= view.lastSeq) return view;
  const v: CodeRunView = { ...view, lastSeq: e.seq };
  const push = (a: Omit<CodeActivity, 'seq' | 'ts'>) => {
    v.activity = [...v.activity, { ...a, seq: e.seq, ts: e.ts }];
  };
  const update = (key: string, patch: Partial<CodeActivity>) => {
    v.activity = v.activity.map((a) => (a.key === key ? { ...a, ...patch } : a));
  };

  switch (e.type) {
    case 'repository.loaded': {
      v.repository = e.data;
      const langs = e.data.languages.slice(0, 3).join(', ');
      push({
        key: 'repo',
        kind: 'repo',
        title: `Loaded ${e.data.repository}`,
        detail: `${e.data.branch} · ${plural(e.data.fileCount, 'file')}${langs ? ` · ${langs}` : ''}${e.data.instructions ? ' · .neuroflow/instructions.md' : ''}`,
        status: 'done',
      });
      break;
    }
    case 'agent.plan.created':
      v.plan = { steps: e.data.steps, ...(e.data.summary ? { summary: e.data.summary } : {}) };
      push({ key: `plan-${e.seq}`, kind: 'plan', title: 'Created a plan', detail: plural(e.data.steps.length, 'step'), status: 'done' });
      break;
    case 'plan.review_required':
      v.pendingPlan = e.data;
      v.plan = { steps: e.data.steps, ...(e.data.summary ? { summary: e.data.summary } : {}) };
      push({ key: `plan-review-${e.data.planId}`, kind: 'approval', title: 'Plan waiting for your review', detail: `revision ${e.data.revision}`, status: 'waiting' });
      break;
    case 'plan.approved':
      v.pendingPlan = undefined;
      v.plan = { ...(v.plan ?? {}), steps: e.data.steps, approved: true };
      update(`plan-review-${e.data.planId}`, { status: 'done', title: e.data.edited ? 'You approved an edited plan' : 'You approved the plan' });
      break;
    case 'plan.rejected':
      v.pendingPlan = undefined;
      update(`plan-review-${e.data.planId}`, {
        status: e.data.willRevise ? 'done' : 'failed',
        title: e.data.willRevise ? 'You asked for a revised plan' : 'You stopped the run at the plan',
        ...(e.data.feedback ? { detail: e.data.feedback } : {}),
      });
      break;
    case 'file.search.started':
      push({ key: `search-${e.data.kind}-${e.data.query}`, kind: 'search', title: `Searching ${e.data.kind === 'text' ? '' : `${e.data.kind} `}“${e.data.query}”`, status: 'active' });
      break;
    case 'file.search.completed': {
      const key = `search-${e.data.kind}-${e.data.query}`;
      const detail = `${plural(e.data.matches, 'match')} in ${plural(e.data.files.length, 'file')}`;
      if (v.activity.some((a) => a.key === key && a.status === 'active')) update(key, { status: 'done', detail });
      else push({ key: `${key}-${e.seq}`, kind: 'search', title: `Searched “${e.data.query}”`, detail, status: 'done' });
      // Re-keying keeps repeated identical searches distinct.
      v.activity = v.activity.map((a) => (a.key === key ? { ...a, key: `${key}-${e.seq}` } : a));
      break;
    }
    case 'file.read':
      if (!v.filesRead.includes(e.data.path)) v.filesRead = [...v.filesRead, e.data.path];
      push({
        key: `read-${e.seq}`,
        kind: 'read',
        title: `Read ${e.data.path}`,
        path: e.data.path,
        ...(e.data.startLine ? { detail: `lines ${e.data.startLine}–${e.data.endLine ?? ''}` } : {}),
        status: 'done',
      });
      break;
    case 'patch.generated':
      push({
        key: `patch-${e.data.patchId}`,
        kind: 'patch',
        title: e.data.valid ? 'Generated a patch' : 'Generated an invalid patch',
        detail: e.data.valid ? changeStat(e.data.files) : e.data.error,
        status: e.data.valid ? 'done' : 'failed',
      });
      break;
    case 'patch.review_required':
      v.reviews = [...v.reviews.filter((r) => r.patchId !== e.data.patchId), { ...e.data, status: 'pending' }];
      push({ key: `review-${e.data.patchId}`, kind: 'approval', title: 'Waiting for your review', detail: changeStat(e.data.files), status: 'waiting' });
      break;
    case 'patch.approved':
      v.reviews = v.reviews.map((r) => (r.patchId === e.data.patchId ? { ...r, status: 'approved' } : r));
      update(`review-${e.data.patchId}`, { status: 'done', title: 'Patch approved' });
      break;
    case 'patch.rejected':
      v.reviews = v.reviews.map((r) => (r.patchId === e.data.patchId ? { ...r, status: 'rejected', ...(e.data.reason ? { reason: e.data.reason } : {}) } : r));
      update(`review-${e.data.patchId}`, { status: 'failed', title: 'Patch rejected', ...(e.data.reason ? { detail: e.data.reason } : {}) });
      break;
    case 'file.modified':
      if (!v.filesModified.includes(e.data.path)) v.filesModified = [...v.filesModified, e.data.path];
      push({
        key: `file-${e.seq}`,
        kind: 'file',
        title: `${{ create: 'Created', modify: 'Modified', delete: 'Deleted', rename: 'Renamed' }[e.data.op]} ${e.data.path}`,
        path: e.data.path,
        detail: `+${e.data.additions} −${e.data.deletions}`,
        status: 'done',
      });
      break;
    case 'command.started':
      v.commands = [...v.commands, { executionId: e.data.executionId, command: e.data.command, kind: e.data.kind, output: '', status: 'running', startedAt: e.ts }];
      if (e.data.kind !== 'test') push({ key: `cmd-${e.data.executionId}`, kind: 'command', title: `Running ${e.data.command}`, status: 'active' });
      break;
    case 'command.output':
      v.commands = v.commands.map((c) =>
        c.executionId === e.data.executionId ? { ...c, output: (c.output + e.data.chunk).slice(-OUTPUT_LIMIT) } : c,
      );
      break;
    case 'command.completed': {
      const status = e.data.timedOut ? 'timeout' : e.data.exitCode === 0 ? 'passed' : 'failed';
      v.commands = v.commands.map((c) => (c.executionId === e.data.executionId ? { ...c, status, exitCode: e.data.exitCode, durationMs: e.data.durationMs } : c));
      update(`cmd-${e.data.executionId}`, {
        status: status === 'passed' ? 'done' : 'failed',
        detail: e.data.timedOut ? `timed out after ${seconds(e.data.durationMs)}` : `exit ${e.data.exitCode} · ${seconds(e.data.durationMs)}`,
      });
      break;
    }
    case 'test.started':
      v.tests = [...v.tests, { executionId: e.data.executionId, command: e.data.command }];
      push({ key: `test-${e.data.executionId}`, kind: 'test', title: `Running tests`, detail: e.data.command, status: 'active' });
      break;
    case 'test.completed': {
      v.tests = v.tests.map((t) =>
        t.executionId === e.data.executionId ? { ...t, passed: e.data.passed, durationMs: e.data.durationMs, ...(e.data.summary ? { summary: e.data.summary } : {}) } : t,
      );
      const s = e.data.summary;
      const counts = s?.total !== undefined ? ` (${s.passed ?? 0}/${s.total})` : s?.failed ? ` (${s.failed} failed)` : '';
      update(`test-${e.data.executionId}`, {
        status: e.data.passed ? 'done' : 'failed',
        title: e.data.passed ? `Tests passed${counts}` : `Tests failed${counts}`,
        detail: seconds(e.data.durationMs),
      });
      break;
    }
    case 'git.diff.updated':
      v.diff = e.data;
      break;
    case 'branch.created':
      push({ key: `git-${e.seq}`, kind: 'git', title: `Created branch ${e.data.branch}`, detail: `from ${e.data.from}`, status: 'done' });
      break;
    case 'commit.created':
      push({ key: `git-${e.seq}`, kind: 'git', title: `Committed ${e.data.sha.slice(0, 7)}`, detail: e.data.message, status: 'done' });
      break;
    case 'push.completed':
      push({ key: `git-${e.seq}`, kind: 'git', title: `Pushed ${e.data.branch}`, detail: e.data.remote, status: 'done' });
      break;
    case 'pull_request.created':
      push({ key: `git-${e.seq}`, kind: 'git', title: `Opened pull request #${e.data.number}`, detail: e.data.title, status: 'done' });
      break;
    case 'approval.requested':
      // Patch approvals are presented as reviews; everything else as an action approval.
      if (!v.reviews.some((r) => r.toolCallId === e.data.toolCallId)) {
        v.approvals = [...v.approvals, e.data];
        push({ key: `approval-${e.data.toolCallId}`, kind: 'approval', title: `Approval needed: ${TOOL_LABEL[e.data.name] ?? e.data.name}`, detail: e.data.reason, status: 'waiting' });
      }
      break;
    case 'approval.resolved':
      v.approvals = v.approvals.filter((a) => a.toolCallId !== e.data.toolCallId);
      update(`approval-${e.data.toolCallId}`, { status: e.data.approved ? 'done' : 'failed', title: e.data.approved ? 'Approved' : 'Declined' });
      break;
    case 'tool.completed':
      v.approvals = v.approvals.filter((a) => a.toolCallId !== e.data.toolCallId);
      // Tool failures the agent will see (and possibly repair) are shown to the user too.
      if (e.data.status !== 'success' && e.data.errorCode !== 'approval_denied') {
        push({ key: `tool-${e.data.toolCallId}`, kind: 'tool', title: `${TOOL_LABEL[e.data.name] ?? e.data.name} failed`, detail: e.data.summary ?? e.data.errorCode, status: 'failed' });
      }
      break;
    case 'evaluation.completed':
      {
        push({
          key: `eval-${e.seq}`,
          kind: 'evaluation',
          title: e.data.verdict === 'passed' ? 'Final check passed' : 'Final check found problems',
          detail: e.data.issues.slice(0, 2).join(' · ') || undefined,
          status: e.data.verdict === 'passed' ? 'done' : 'failed',
        });
      }
      break;
    case 'code.run.completed':
      v.completed = e.data;
      break;
    case 'run.cancelled':
    case 'run.failed':
      v.pendingPlan = undefined;
      v.approvals = [];
      v.reviews = v.reviews.map((r) => (r.status === 'pending' ? { ...r, status: 'rejected', reason: 'Run ended' } : r));
      v.activity = v.activity.map((a) => (a.status === 'active' || a.status === 'waiting' ? { ...a, status: 'failed' } : a));
      v.commands = v.commands.map((c) => (c.status === 'running' ? { ...c, status: 'failed' } : c));
      break;
    case 'run.completed':
      v.activity = v.activity.map((a) => (a.status === 'active' ? { ...a, status: 'done' } : a));
      break;
    default:
      break;
  }
  return v;
}

export function reduceCodeEvents(events: RunEvent[]): CodeRunView {
  return events.reduce(applyCodeEvent, emptyCodeRunView());
}
