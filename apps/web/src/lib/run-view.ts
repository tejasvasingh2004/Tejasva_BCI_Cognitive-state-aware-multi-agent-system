import type { ExecutionPlan, RunEvent, Usage } from '@neuroflow/contracts';

export type StepStatus = 'active' | 'done' | 'failed' | 'waiting';

export type TimelineStep = {
  key: string;
  label: string;
  detail?: string;
  status: StepStatus;
  kind: 'run' | 'router' | 'agent' | 'model' | 'tool' | 'memory' | 'evaluation' | 'approval' | 'cognitive';
  startedAt: number;
  endedAt?: number;
};

export type PendingApproval = { toolCallId: string; name: string; riskLevel: string; arguments: unknown; expiresAt: string };

export type RunView = {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Human-readable summary of what is happening right now (derived from real events only). */
  phase: string;
  text: string;
  plan?: ExecutionPlan;
  steps: TimelineStep[];
  approvals: PendingApproval[];
  toolsUsed: string[];
  retries: number;
  fallbacks: number;
  memoryQueries: Array<{
    query: string;
    count: number;
    items: Array<{ id: string; source: string; tags: string[]; createdAt: string }>;
  }>;
  evaluation?: { verdict: string; score?: number; issues: string[] };
  usage?: Usage;
  error?: { code: string; message: string; stage?: string };
  startedAt?: number;
  endedAt?: number;
  lastSeq: number;
  attempt: number;
};

export const emptyRunView = (): RunView => ({
  status: 'queued',
  phase: 'Starting task',
  text: '',
  steps: [],
  approvals: [],
  toolsUsed: [],
  retries: 0,
  fallbacks: 0,
  memoryQueries: [],
  lastSeq: 0,
  attempt: 0,
});

const AGENT_PHASE: Record<string, string> = {
  assistant: 'Working on it',
  researcher: 'Researching',
  analyst: 'Analyzing',
  writer: 'Writing response',
  supervisor: 'Coordinating specialists',
  critic: 'Evaluating',
  refiner: 'Refining the answer',
  code: 'Working in the repository',
};

export const STRATEGY_LABEL: Record<string, string> = {
  direct: 'Direct',
  single_agent: 'Single agent',
  sequential: 'Sequential agents',
  parallel: 'Parallel agents',
  supervisor: 'Supervisor',
  evaluator_optimizer: 'Evaluate & refine',
};

export const TOOL_LABEL: Record<string, string> = {
  search_memory: 'Searching memory',
  save_memory: 'Saving to memory',
  delete_memory: 'Forgetting a memory',
  calculator: 'Calculating',
  get_current_time: 'Checking the time',
  list_files: 'Exploring the repository',
  read_file: 'Reading code',
  search_code: 'Searching code',
  find_symbol: 'Finding a symbol',
  find_references: 'Finding references',
  create_file: 'Creating a file',
  edit_file: 'Editing code',
  rename_file: 'Renaming a file',
  delete_file: 'Deleting a file',
  apply_patch: 'Applying a patch',
  run_command: 'Running a command',
  run_tests: 'Running tests',
  run_linter: 'Running the linter',
  run_build: 'Building',
  git_status: 'Checking Git status',
  git_diff: 'Reviewing the diff',
  git_log: 'Reading Git history',
  create_branch: 'Creating a branch',
  commit: 'Committing',
  push: 'Pushing',
  get_repository: 'Reading repository details',
  get_branch: 'Reading branch details',
  get_pull_requests: 'Listing pull requests',
  get_issues: 'Listing issues',
  create_issue: 'Creating an issue',
  create_pull_request: 'Opening a pull request',
  review_pull_request: 'Reviewing a pull request',
};

export const modelName = (ref: string) => ref.slice(ref.indexOf('/') + 1);

/** Pure reducer from backend events to UI state. Nothing here invents progress. */
export function applyRunEvent(view: RunView, e: RunEvent): RunView {
  if (e.seq <= view.lastSeq) return view;
  const t = Date.parse(e.ts);
  const v: RunView = { ...view, lastSeq: e.seq, steps: [...view.steps] };
  const finish = (key: string, status: StepStatus = 'done', detail?: string) => {
    const i = v.steps.findIndex((s) => s.key === key);
    if (i >= 0) v.steps[i] = { ...v.steps[i]!, status, endedAt: t, ...(detail ? { detail } : {}) };
  };
  const push = (step: Omit<TimelineStep, 'startedAt'>) => v.steps.push({ ...step, startedAt: t });

  switch (e.type) {
    case 'run.created':
    case 'run.queued':
      v.phase = 'Starting task';
      break;
    case 'run.started':
      v.status = 'running';
      v.attempt = e.data.attempt;
      v.startedAt ??= t;
      v.phase = e.data.attempt > 1 ? 'Resuming after interruption' : 'Starting task';
      break;
    case 'router.started':
      v.phase = 'Selecting execution strategy';
      push({ key: 'router', kind: 'router', label: 'Selecting execution strategy', status: 'active' });
      break;
    case 'router.selected':
      v.plan = e.data.plan;
      finish('router', 'done', STRATEGY_LABEL[e.data.plan.agentStrategy]);
      break;
    case 'cognitive.applied':
      push({
        key: `cognitive-${e.seq}`,
        kind: 'cognitive',
        label: e.data.available ? `Adapting to ${e.data.policy?.workload ?? ''} workload` : 'Cognitive signal unavailable',
        detail: e.data.reason,
        status: 'done',
      });
      break;
    case 'agent.started':
      v.phase = AGENT_PHASE[e.data.agentId] ?? `Running ${e.data.name}`;
      push({ key: `agent-${e.data.agentExecutionId}`, kind: 'agent', label: e.data.name, detail: modelName(e.data.model), status: 'active' });
      break;
    case 'agent.completed':
      finish(`agent-${e.data.agentExecutionId}`, e.data.status === 'completed' ? 'done' : 'failed');
      break;
    case 'model.started':
      if (!v.steps.some((s) => s.kind === 'agent' && s.status === 'active')) {
        v.phase = `Generating with ${modelName(e.data.model)}`;
        push({ key: `model-${e.data.callId}`, kind: 'model', label: 'Model', detail: modelName(e.data.model), status: 'active' });
      }
      break;
    case 'model.retry':
      v.retries++;
      break;
    case 'model.throttled':
      v.phase = `Waiting for ${e.data.provider} capacity (~${Math.max(1, Math.round(e.data.waitMs / 1000))}s)`;
      break;
    case 'model.hedged':
      v.phase = `Slow first token: also asking ${modelName(e.data.to)}`;
      break;
    case 'model.fallback':
      v.fallbacks++;
      v.phase = e.data.sameModel ? `Same model, another provider: ${modelName(e.data.to)}` : `Switching to ${modelName(e.data.to)}`;
      break;
    case 'model.completed':
      finish(`model-${e.data.callId}`, e.data.status === 'completed' ? 'done' : 'failed');
      break;
    case 'tool.started':
      v.phase = TOOL_LABEL[e.data.name] ?? `Running ${e.data.name}`;
      if (!v.toolsUsed.includes(e.data.name)) v.toolsUsed = [...v.toolsUsed, e.data.name];
      push({ key: `tool-${e.data.toolCallId}`, kind: 'tool', label: TOOL_LABEL[e.data.name] ?? e.data.name, status: 'active' });
      break;
    case 'tool.completed':
      finish(`tool-${e.data.toolCallId}`, e.data.status === 'success' ? 'done' : 'failed', e.data.summary ?? (e.data.status === 'success' ? undefined : e.data.errorCode));
      v.approvals = v.approvals.filter((a) => a.toolCallId !== e.data.toolCallId);
      break;
    case 'approval.requested':
      v.phase = 'Waiting for your approval';
      v.approvals = [...v.approvals, e.data];
      push({ key: `approval-${e.data.toolCallId}`, kind: 'approval', label: `Approval needed: ${e.data.name}`, status: 'waiting' });
      break;
    case 'approval.resolved':
      v.approvals = v.approvals.filter((a) => a.toolCallId !== e.data.toolCallId);
      finish(`approval-${e.data.toolCallId}`, e.data.approved ? 'done' : 'failed', e.data.approved ? 'Approved' : 'Declined');
      break;
    case 'memory.completed':
      v.memoryQueries = [...v.memoryQueries, { query: e.data.query, count: e.data.count, items: e.data.items ?? [] }];
      break;
    case 'evaluation.started':
      v.phase = 'Evaluating';
      push({ key: `eval-${e.data.iteration}-${e.seq}`, kind: 'evaluation', label: 'Evaluating response', status: 'active' });
      break;
    case 'evaluation.completed': {
      v.evaluation = { verdict: e.data.verdict, score: e.data.score, issues: e.data.issues };
      const active = [...v.steps].reverse().find((s) => s.kind === 'evaluation' && s.status === 'active');
      if (active) finish(active.key, 'done', e.data.verdict.replace('_', ' '));
      break;
    }
    case 'response.delta':
      v.text += e.data.text;
      if (v.status === 'running' && v.approvals.length === 0 && !v.phase.startsWith('Evaluat')) v.phase = 'Writing response';
      break;
    case 'response.reset':
      v.text = '';
      v.phase = 'Refining the answer';
      break;
    case 'run.completed':
      v.status = 'completed';
      v.phase = 'Completed';
      v.usage = e.data.usage;
      v.endedAt = t;
      v.steps = v.steps.map((s) => (s.status === 'active' ? { ...s, status: 'done', endedAt: t } : s));
      break;
    case 'run.failed':
      v.status = 'failed';
      v.phase = 'Failed';
      v.error = e.data.error;
      v.endedAt = t;
      v.steps = v.steps.map((s) => (s.status === 'active' ? { ...s, status: 'failed', endedAt: t } : s));
      break;
    case 'run.cancelled':
      v.status = 'cancelled';
      v.phase = 'Stopped';
      v.endedAt = t;
      v.steps = v.steps.map((s) => (s.status === 'active' || s.status === 'waiting' ? { ...s, status: 'failed', endedAt: t } : s));
      v.approvals = [];
      break;
    default:
      break;
  }
  return v;
}

export function reduceRunEvents(events: RunEvent[]): RunView {
  return events.reduce(applyRunEvent, emptyRunView());
}
