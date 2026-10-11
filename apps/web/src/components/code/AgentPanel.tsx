import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  Circle,
  CircleDashed,
  FileCode2,
  FileSearch,
  FlaskConical,
  GitCommitHorizontal,
  History,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Pin,
  ShieldAlert,
  Square,
  Terminal,
  X,
  XCircle,
} from 'lucide-react';
import type { ApprovalMode, CodeWorkspace, Run, StoredMessage } from '@neuroflow/contracts';
import { codeApi } from '@/lib/code-api';
import type { ActionApproval, CodeActivity, CodeRunView, PatchReview } from '@/lib/code-run-view';
import type { RunView } from '@/lib/run-view';
import { cn, formatDuration } from '@/lib/utils';
import { codeKeys, useCodeRun, useCodeRunView } from '@/hooks/code';
import { keys, useConversation, useModels } from '@/hooks/queries';
import { navigateTo } from '@/hooks/route';
import { useCode, type AgentTab } from '@/stores/code';
import { useToasts } from '@/stores/toasts';
import { Button } from '@/components/ui/button';
import { Sparkle } from '@/components/ui/sparkle';
import { Tooltip } from '@/components/ui/tooltip';
import { Markdown } from '@/components/workspace/Markdown';
import { DiffStat, DiffView } from './DiffView';
import { PlanReviewer } from './PlanReviewer';
import { AGENT_ACTIONS, type AgentAction } from './EditorArea';
import { APPROVAL_MODES, errorMessage, Segmented } from './shared';

export type AgentPanelHandle = { focus(): void; ask(action: AgentAction): void };

/** Starts Code Agent runs with the editor context (active file, selection, pinned files). */
export function useAgentRunner(workspace: CodeWorkspace) {
  const qc = useQueryClient();
  const setActiveRun = useCode((s) => s.setActiveRun);
  const setConversation = useCode((s) => s.setConversation);
  const pushToast = useToasts((s) => s.push);
  return useMutation({
    mutationFn: async (input: { instruction: string; action?: AgentAction; model?: string }) => {
      const s = useCode.getState();
      const mode = s.approvalMode[workspace.id] ?? workspace.approvalMode;
      const sel = s.selection && s.selection.path === s.activePath ? s.selection : null;
      return codeApi.startRun(
        {
          codeWorkspaceId: workspace.id,
          instruction: input.instruction,
          approvalMode: mode,
          ...(s.activePath ? { activeFile: s.activePath } : {}),
          ...(sel ? { selection: { startLine: sel.startLine, endLine: sel.endLine } } : {}),
          ...(s.pinned.length ? { context: s.pinned } : {}),
          ...(input.action ? { action: input.action } : {}),
          ...(s.planReview[workspace.id] ? { planReview: true } : {}),
          ...(input.model && input.model !== 'auto' ? { selectedModel: input.model } : {}),
          ...(s.conversation[workspace.id] ? { conversationId: s.conversation[workspace.id]! } : {}),
        },
        crypto.randomUUID(),
      );
    },
    onSuccess: (res) => {
      setActiveRun(workspace.id, res.run.id);
      setConversation(workspace.id, res.conversationId);
      void qc.invalidateQueries({ queryKey: keys.conversation(res.conversationId) });
      void qc.invalidateQueries({ queryKey: codeKeys.runs(workspace.id) });
    },
    onError: (err) => pushToast({ tone: 'error', title: 'Could not start the Code Agent', body: errorMessage(err) }),
  });
}

export const AgentPanel = forwardRef<AgentPanelHandle, { workspace: CodeWorkspace }>(function AgentPanel({ workspace }, ref) {
  const tab = useCode((s) => s.agentTab);
  const setTab = useCode((s) => s.setAgentTab);
  const runId = useCode((s) => s.activeRun[workspace.id] ?? null);
  const conversationId = useCode((s) => s.conversation[workspace.id] ?? null);
  const { view, code } = useCodeRunView(workspace.id, runId);
  const runner = useAgentRunner(workspace);
  const composerRef = useRef<ComposerHandle>(null);
  const pending = (code?.reviews.filter((r) => r.status === 'pending').length ?? 0) + (code?.approvals.length ?? 0);

  // A pending review pulls attention to the Approvals tab once.
  const lastPending = useRef(0);
  useEffect(() => {
    if (pending > lastPending.current) setTab('approvals');
    lastPending.current = pending;
  }, [pending, setTab]);
  // A plan waiting for review opens the Plan tab (once per plan revision).
  const pendingPlanId = code?.pendingPlan?.planId;
  const lastPlan = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pendingPlanId && pendingPlanId !== lastPlan.current) setTab('plan');
    lastPlan.current = pendingPlanId;
  }, [pendingPlanId, setTab]);

  const ask = useCallback(
    (action: AgentAction) => {
      const s = useCode.getState();
      const def = AGENT_ACTIONS.find((a) => a.id === action)!;
      const sel = s.selection && s.selection.path === s.activePath ? s.selection : null;
      const where = sel ? `${s.activePath} (lines ${sel.startLine}–${sel.endLine})` : s.activePath ? s.activePath : 'the repository';
      setTab('chat');
      runner.mutate({ instruction: `${def.prompt}\n\nTarget: ${where}`, action });
    },
    [runner, setTab],
  );
  useImperativeHandle(ref, () => ({ focus: () => composerRef.current?.focus(), ask }), [ask]);

  const running = runner.isPending || view?.status === 'queued' || view?.status === 'running';
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 px-2">
        <Segmented<AgentTab>
          size="xs"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'chat', label: 'Chat', testId: 'agent-chat' },
            { id: 'plan', label: 'Plan', badge: code?.pendingPlan ? 1 : undefined, testId: 'agent-plan' },
            { id: 'activity', label: 'Activity', testId: 'agent-activity' },
            { id: 'context', label: 'Context', testId: 'agent-context' },
            { id: 'approvals', label: 'Approvals', badge: pending, testId: 'agent-approvals' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'chat' && <ChatTab workspace={workspace} conversationId={conversationId} runId={runId} view={view} code={code} pendingText={runner.isPending ? runner.variables?.instruction : undefined} />}
        {tab === 'plan' && <PlanTab view={view} code={code} runId={runId} />}
        {tab === 'activity' && <ActivityTab view={view} code={code} />}
        {tab === 'context' && <ContextTab workspace={workspace} runId={runId} code={code} />}
        {tab === 'approvals' && <ApprovalsTab runId={runId} code={code} />}
      </div>
      <AgentComposer ref={composerRef} workspace={workspace} running={running} runId={runId} onSubmit={(t, model) => runner.mutate({ instruction: t, model })} />
    </div>
  );
});

// ---------------------------------------------------------------------------------------- chat

type Turn = { run: Run; user?: StoredMessage; assistant?: StoredMessage };

function ChatTab({
  workspace,
  conversationId,
  runId,
  view,
  code,
  pendingText,
}: {
  workspace: CodeWorkspace;
  conversationId: string | null;
  runId: string | null;
  view: RunView | null;
  code: CodeRunView | null;
  pendingText?: string;
}) {
  const { data: detail } = useConversation(conversationId);
  const setActiveRun = useCode((s) => s.setActiveRun);
  const setConversation = useCode((s) => s.setConversation);
  const bottom = useRef<HTMLDivElement>(null);
  const turns: Turn[] = useMemo(
    () =>
      (detail?.runs ?? []).map((run) => ({
        run,
        user: detail?.messages.find((m) => m.runId === run.id && m.role === 'user'),
        assistant: detail?.messages.find((m) => m.runId === run.id && m.role === 'assistant'),
      })),
    [detail],
  );
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, view?.text.length, code?.activity.length, pendingText]);

  if (!turns.length && !pendingText) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Sparkle className="size-8" />
        <div className="text-sm font-medium text-ink">Code Agent</div>
        <p className="text-xs leading-5 text-muted">
          Ask about {workspace.repository.name}, or ask for a change. The agent explores the repository, plans, proposes patches for your review, and validates them with
          tests in the sandbox.
        </p>
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          {['Explain the architecture of this repository', 'Find and fix failing tests', 'Add input validation where it is missing'].map((s) => (
            <SuggestionChip key={s} text={s} workspace={workspace} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5 px-3 py-4" data-testid="agent-thread">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          onClick={() => {
            setConversation(workspace.id, null);
            setActiveRun(workspace.id, null);
          }}
        >
          <MessageSquarePlus className="size-3" /> New chat
        </Button>
      </div>
      {turns.map((t) => (
        <div key={t.run.id} className="flex flex-col gap-3">
          {t.user && <UserMessage text={t.user.content} />}
          {t.run.id === runId ? (
            <LiveTurn workspace={workspace} run={t.run} view={view} code={code} assistant={t.assistant} />
          ) : (
            <PastTurn workspace={workspace} run={t.run} assistant={t.assistant} onFocus={() => setActiveRun(workspace.id, t.run.id)} />
          )}
        </div>
      ))}
      {pendingText && !turns.some((t) => t.run.id === runId && t.user?.content === pendingText) && (
        <div className="flex flex-col gap-3">
          <UserMessage text={pendingText} />
          <div className="flex items-center gap-2 text-xs text-muted">
            <Sparkle className="size-3.5" animated /> <span className="shimmer-text font-medium">Starting</span>
          </div>
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}

function SuggestionChip({ text, workspace }: { text: string; workspace: CodeWorkspace }) {
  const runner = useAgentRunner(workspace);
  return (
    <button onClick={() => runner.mutate({ instruction: text })} className="rounded-full bg-surface/80 px-3 py-1 text-[11px] text-ink-soft transition hover:bg-surface hover:text-ink">
      {text}
    </button>
  );
}

function UserMessage({ text }: { text: string }) {
  // The structured "Target:" suffix is shown as a chip rather than prose.
  const [body, target] = text.split('\n\nTarget: ');
  return (
    <div className="ml-6 self-end rounded-2xl rounded-br-md bg-violet-soft px-3 py-2 text-[13px] leading-5 text-ink">
      <div className="whitespace-pre-wrap">{body}</div>
      {target && (
        <div className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full bg-surface/70 px-2 py-0.5 font-mono text-[10.5px] text-muted">
          <FileCode2 className="size-3 shrink-0" /> <span className="truncate">{target}</span>
        </div>
      )}
    </div>
  );
}

function RunSummary({ workspace, runId, files, testsPassed }: { workspace: CodeWorkspace; runId: string; files?: Array<{ additions: number; deletions: number }>; testsPassed?: boolean | null }) {
  const setBottomTab = useCode((s) => s.setBottomTab);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
      {files && files.length > 0 && (
        <button className="hover:text-ink" onClick={() => setBottomTab('diff')} title="Open the Git Diff panel">
          <DiffStat files={files} />
        </button>
      )}
      {testsPassed != null && (
        <span className={cn('inline-flex items-center gap-1', testsPassed ? 'text-emerald-600' : 'text-rose-500')}>
          <FlaskConical className="size-3" /> {testsPassed ? 'tests passed' : 'tests failed'}
        </span>
      )}
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => navigateTo(`/code/${workspace.id}/replay/${runId}`)} data-testid="open-replay">
        <History className="size-3" /> Replay
      </button>
    </div>
  );
}

function LiveTurn({ workspace, run, view, code, assistant }: { workspace: CodeWorkspace; run: Run; view: RunView | null; code: CodeRunView | null; assistant?: StoredMessage }) {
  const status = view?.status ?? run.status;
  const live = status === 'queued' || status === 'running';
  const text = view?.text || assistant?.content || '';
  const recent = (code?.activity ?? []).slice(live ? -4 : 0);
  const pendingReviews = code?.reviews.filter((r) => r.status === 'pending') ?? [];
  return (
    <div className="flex flex-col gap-2.5">
      {live && (
        <div className="flex items-center gap-2 text-xs">
          <Sparkle className="size-3.5" animated />
          <span className="shimmer-text font-medium" data-testid="agent-phase">
            {view?.phase ?? 'Starting'}
          </span>
        </div>
      )}
      {code?.pendingPlan && (
        <button
          onClick={() => useCode.getState().setAgentTab('plan')}
          className="flex items-center gap-2 rounded-xl border border-accent/30 bg-violet-soft/40 px-3 py-2 text-left text-xs text-ink hover:bg-violet-soft/60"
          data-testid="open-plan-review"
        >
          <ListChecks className="size-4 shrink-0 text-accent" />
          <span className="flex-1">The plan is ready for your review — nothing changes until you approve.</span>
          <span className="font-medium text-accent">Review plan</span>
        </button>
      )}
      {code?.plan && live && !code.pendingPlan && (
        <div className="rounded-xl bg-surface/60 px-3 py-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">Plan</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-ink-soft">
            {code.plan.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      {live && recent.length > 0 && (
        <div className="flex flex-col gap-1">
          {recent.map((a) => (
            <ActivityRow key={a.key} a={a} compact />
          ))}
        </div>
      )}
      {pendingReviews.map((r) => (
        <ReviewCard key={r.patchId} runId={run.id} review={r} compact />
      ))}
      {code?.approvals.map((a) => (
        <ActionApprovalCard key={a.toolCallId} runId={run.id} approval={a} />
      ))}
      {text && (
        <div className="prose-nf text-[13px]">
          <Markdown text={text} streaming={live} />
        </div>
      )}
      {status === 'failed' && (
        <div className="flex items-start gap-2 rounded-xl bg-rose-soft px-3 py-2 text-xs text-rose-600">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {view?.error?.message ?? run.error?.message ?? 'The run failed'}
        </div>
      )}
      {status === 'cancelled' && <div className="text-xs text-faint">Stopped.</div>}
      {!live && <RunSummary workspace={workspace} runId={run.id} files={code?.diff?.files} testsPassed={code?.completed?.testsPassed} />}
    </div>
  );
}

function PastTurn({ workspace, run, assistant, onFocus }: { workspace: CodeWorkspace; run: Run; assistant?: StoredMessage; onFocus(): void }) {
  const [open, setOpen] = useState(false);
  const text = assistant?.content ?? '';
  return (
    <div className="flex flex-col gap-2">
      {text ? (
        <div className={cn('prose-nf relative text-[13px]', !open && 'max-h-40 overflow-hidden')}>
          <Markdown text={text} />
          {!open && text.length > 400 && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--glass-strong-bg)] to-transparent" />}
        </div>
      ) : (
        <div className="text-xs capitalize text-faint">{run.status}</div>
      )}
      <div className="flex items-center gap-3 text-[11px] text-muted">
        {text.length > 400 && (
          <button className="hover:text-ink" onClick={() => setOpen((v) => !v)}>
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
        <button className="hover:text-ink" onClick={onFocus}>
          Show details
        </button>
        <RunSummary workspace={workspace} runId={run.id} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------- reviews

export function ReviewCard({ runId, review, compact }: { runId: string; review: PatchReview; compact?: boolean }) {
  const [expanded, setExpanded] = useState(!compact);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const pushToast = useToasts((s) => s.push);
  const decide = useMutation({
    mutationFn: (approved: boolean) => (approved ? codeApi.approve(runId, { patchId: review.patchId }) : codeApi.reject(runId, { patchId: review.patchId, ...(reason ? { reason } : {}) })),
    onError: (err) => pushToast({ tone: 'error', title: 'Decision not recorded', body: errorMessage(err) }),
  });
  const done = review.status !== 'pending' || decide.isSuccess;
  return (
    <div className="overflow-hidden rounded-2xl border border-accent/25 bg-surface/80 shadow-soft" data-testid="patch-review">
      <div className="flex items-center gap-2 px-3 py-2">
        <ShieldAlert className="size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-ink">{review.status === 'pending' ? 'Review proposed changes' : review.status === 'approved' ? 'Changes approved' : 'Changes rejected'}</div>
          <div className="truncate text-[11px] text-muted">{review.files.map((f) => f.path).join(', ')}</div>
        </div>
        <DiffStat files={review.files} />
      </div>
      {compact && (
        <button className="w-full border-t border-line px-3 py-1 text-left text-[11px] text-accent hover:bg-violet-soft/30" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide diff' : 'Show diff'}
        </button>
      )}
      {expanded && (
        <div className="max-h-96 overflow-y-auto border-t border-line p-2">
          <DiffView diff={review.diff} onOpenFile={(p) => useCode.getState().openFile(p)} />
        </div>
      )}
      {!done && (
        <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
          {rejecting && (
            <input
              autoFocus
              className="w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent/50"
              placeholder="Why? (optional — the agent sees this)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && decide.mutate(false)}
            />
          )}
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" disabled={decide.isPending} onClick={() => (rejecting ? decide.mutate(false) : setRejecting(true))} data-testid="reject-patch">
              <X className="size-3.5" /> {rejecting ? 'Reject' : 'Reject…'}
            </Button>
            <Button variant="primary" size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)} data-testid="approve-patch">
              <Check className="size-3.5" /> Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function previewText(preview: unknown): string | null {
  if (!preview) return null;
  if (typeof preview === 'string') return preview;
  const p = preview as Record<string, unknown>;
  if (typeof p.command === 'string') return `$ ${p.command}`;
  if (typeof p.diff === 'string') return p.diff;
  return JSON.stringify(preview, null, 2).slice(0, 2000);
}

export function ActionApprovalCard({ runId, approval }: { runId: string; approval: ActionApproval }) {
  const pushToast = useToasts((s) => s.push);
  const decide = useMutation({
    mutationFn: (approved: boolean) => (approved ? codeApi.approve(runId, { toolCallId: approval.toolCallId }) : codeApi.reject(runId, { toolCallId: approval.toolCallId })),
    onError: (err) => pushToast({ tone: 'error', title: 'Decision not recorded', body: errorMessage(err) }),
  });
  const preview = previewText(approval.preview);
  const diff = (approval.preview as { diff?: string } | undefined)?.diff;
  return (
    <div className="overflow-hidden rounded-2xl border border-amber-300/50 bg-surface/80 shadow-soft" data-testid="action-approval">
      <div className="flex items-start gap-2 px-3 py-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-ink">
            Allow <span className="font-mono">{approval.name}</span>?
            <span className="ml-1.5 rounded-full bg-peach-soft px-1.5 text-[10px] font-medium capitalize text-amber-700">{approval.riskLevel} risk</span>
          </div>
          {approval.reason && <div className="mt-0.5 text-[11px] leading-4 text-muted">{approval.reason}</div>}
        </div>
      </div>
      {diff ? (
        <div className="max-h-72 overflow-y-auto border-t border-line p-2">
          <DiffView diff={diff} />
        </div>
      ) : (
        preview && <pre className="max-h-40 overflow-auto border-t border-line bg-canvas/60 px-3 py-2 font-mono text-[11px] text-ink-soft">{preview}</pre>
      )}
      {!decide.isSuccess && (
        <div className="flex justify-end gap-1.5 border-t border-line px-3 py-2">
          <Button variant="ghost" size="sm" disabled={decide.isPending} onClick={() => decide.mutate(false)} data-testid="decline-action">
            Decline
          </Button>
          <Button variant="primary" size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)} data-testid="approve-action">
            Allow once
          </Button>
        </div>
      )}
    </div>
  );
}

function ApprovalsTab({ runId, code }: { runId: string | null; code: CodeRunView | null }) {
  if (!runId || !code) return <Empty text="Approvals for agent changes, commands and Git operations appear here." />;
  const pending = code.reviews.filter((r) => r.status === 'pending');
  const decided = code.reviews.filter((r) => r.status !== 'pending');
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {pending.length === 0 && code.approvals.length === 0 && <div className="py-2 text-center text-xs text-faint">Nothing is waiting for you.</div>}
      {pending.map((r) => (
        <ReviewCard key={r.patchId} runId={runId} review={r} />
      ))}
      {code.approvals.map((a) => (
        <ActionApprovalCard key={a.toolCallId} runId={runId} approval={a} />
      ))}
      {decided.length > 0 && (
        <>
          <div className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Decided</div>
          {decided.map((r) => (
            <ReviewCard key={r.patchId} runId={runId} review={r} compact />
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------- plan / activity / context

function PlanTab({ view, code, runId }: { view: RunView | null; code: CodeRunView | null; runId: string | null }) {
  if (code?.pendingPlan && runId) {
    return (
      <div className="px-3 py-3">
        <PlanReviewer runId={runId} plan={code.pendingPlan} />
      </div>
    );
  }
  if (!code?.plan) {
    return <Empty text={view && (view.status === 'running' || view.status === 'queued') ? 'The agent is understanding the repository…' : 'The agent’s plan for the current task appears here.'} />;
  }
  const finished = view?.status === 'completed';
  return (
    <div className="px-4 py-4">
      {code.plan.approved && <p className="mb-2 text-[11px] font-medium text-emerald-600">Approved by you</p>}
      {code.plan.summary && <p className="mb-3 text-[13px] leading-5 text-ink">{code.plan.summary}</p>}
      <ol className="flex flex-col gap-2">
        {code.plan.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[13px] text-ink-soft">
            {finished ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <Circle className="mt-0.5 size-4 shrink-0 text-faint" />}
            <span>
              <span className="mr-1 text-faint">{i + 1}.</span>
              {s}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-[11px] text-faint">The plan is a working outline; the agent adapts it as it learns more about the code.</p>
    </div>
  );
}

const ACTIVITY_ICON: Record<CodeActivity['kind'], typeof Circle> = {
  repo: FileSearch,
  plan: ListChecks,
  search: FileSearch,
  read: FileCode2,
  patch: Pencil,
  file: Pencil,
  command: Terminal,
  test: FlaskConical,
  git: GitCommitHorizontal,
  approval: ShieldAlert,
  tool: AlertTriangle,
  evaluation: CheckCircle2,
  run: Circle,
};

function ActivityRow({ a, compact }: { a: CodeActivity; compact?: boolean }) {
  const Icon = ACTIVITY_ICON[a.kind];
  const openFile = useCode((s) => s.openFile);
  return (
    <div className={cn('flex items-start gap-2 text-xs', compact ? 'text-muted' : 'text-ink-soft')}>
      <span className="mt-0.5 shrink-0">
        {a.status === 'active' ? (
          <Loader2 className="size-3.5 animate-spin text-accent" />
        ) : a.status === 'waiting' ? (
          <CircleDashed className="size-3.5 text-amber-500" />
        ) : a.status === 'failed' ? (
          <XCircle className="size-3.5 text-rose-500" />
        ) : (
          <Icon className="size-3.5 text-faint" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {a.path ? (
          <button className="max-w-full truncate text-left hover:text-accent hover:underline" onClick={() => openFile(a.path!)}>
            {a.title}
          </button>
        ) : (
          <div className="truncate">{a.title}</div>
        )}
        {a.detail && !compact && <div className="truncate text-[11px] text-faint">{a.detail}</div>}
      </div>
      {compact && a.detail && <span className="max-w-[40%] shrink-0 truncate text-[11px] text-faint">{a.detail}</span>}
    </div>
  );
}

function ActivityTab({ view, code }: { view: RunView | null; code: CodeRunView | null }) {
  if (!code || !code.activity.length) return <Empty text="Every step the agent takes — searches, file reads, patches, commands, tests — is listed here as it happens." />;
  return (
    <div className="flex flex-col gap-2 px-3 py-3" data-testid="activity-list">
      {code.activity.map((a) => (
        <ActivityRow key={a.key} a={a} />
      ))}
      {view && (view.status === 'completed' || view.status === 'failed') && (
        <div className="mt-2 border-t border-line pt-2 text-[11px] text-faint">
          {view.status === 'completed' ? 'Completed' : 'Failed'} in {formatDuration((view.endedAt ?? 0) - (view.startedAt ?? 0))}
          {view.retries ? ` · ${view.retries} retries` : ''}
          {view.usage ? ` · ${view.usage.totalTokens ?? ''} tokens` : ''}
        </div>
      )}
    </div>
  );
}

function ContextTab({ workspace, runId, code }: { workspace: CodeWorkspace; runId: string | null; code: CodeRunView | null }) {
  const { data: detail } = useCodeRun(runId);
  const pinned = useCode((s) => s.pinned);
  const togglePin = useCode((s) => s.togglePin);
  const activePath = useCode((s) => s.activePath);
  const selection = useCode((s) => s.selection);
  const openFile = useCode((s) => s.openFile);
  const items = detail?.context ?? [];
  return (
    <div className="flex flex-col gap-4 px-3 py-3 text-xs">
      <section>
        <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Next request will include</div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-ink-soft">
            <FileCode2 className="size-3.5 text-faint" /> {activePath ? <span className="truncate font-mono">{activePath}</span> : <span className="text-faint">No active file</span>}
          </div>
          {selection && selection.path === activePath && (
            <div className="pl-5 text-[11px] text-muted">
              Selection: lines {selection.startLine}–{selection.endLine}
            </div>
          )}
          {pinned.map((p) => (
            <div key={p} className="flex items-center gap-2 text-ink-soft">
              <Pin className="size-3.5 text-accent" /> <span className="min-w-0 flex-1 truncate font-mono">{p}</span>
              <button className="text-faint hover:text-rose-500" onClick={() => togglePin(p)} aria-label={`Unpin ${p}`}>
                <X className="size-3" />
              </button>
            </div>
          ))}
          {!pinned.length && <div className="text-[11px] text-faint">Pin files from the explorer to add them as context.</div>}
          <div className="text-[11px] text-faint">
            Plus repository map, project profile{workspace ? '' : ''} and .neuroflow/instructions.md when present. The whole repository is never sent.
          </div>
        </div>
      </section>
      {code?.repository && (
        <section>
          <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Repository understanding</div>
          <div className="text-ink-soft">
            {code.repository.repository} · {code.repository.projectKind} · {code.repository.fileCount} files
          </div>
          <div className="text-[11px] text-muted">{code.repository.languages.join(', ')}</div>
        </section>
      )}
      {runId && (
        <section>
          <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Used in the current task</div>
          {items.length === 0 && (code?.filesRead.length ?? 0) === 0 && <div className="text-[11px] text-faint">Nothing yet.</div>}
          <div className="flex flex-col gap-0.5">
            {(items.length ? items : (code?.filesRead ?? []).map((p) => ({ kind: 'file', path: p, startLine: null, endLine: null, detail: null }))).map((c, i) => (
              <button key={i} className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface/60" onClick={() => c.path && openFile(c.path)} disabled={!c.path}>
                <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-faint">{c.kind.replace('_', ' ')}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft">
                  {c.path ?? c.detail}
                  {c.startLine ? `:${c.startLine}${c.endLine ? `-${c.endLine}` : ''}` : ''}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center px-8 text-center text-xs leading-5 text-faint">{text}</div>;
}

// ---------------------------------------------------------------------------------------- composer

type ComposerHandle = { focus(): void };

const AgentComposer = forwardRef<ComposerHandle, { workspace: CodeWorkspace; running: boolean; runId: string | null; onSubmit(text: string, model: string): void }>(
  function AgentComposer({ workspace, running, runId, onSubmit }, ref) {
    const [text, setText] = useState('');
    const [model, setModel] = useState('auto');
    const area = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);
    const mode = useCode((s) => s.approvalMode[workspace.id] ?? workspace.approvalMode);
    const setMode = useCode((s) => s.setApprovalMode);
    const planFirst = useCode((s) => s.planReview[workspace.id] ?? false);
    const setPlanFirst = useCode((s) => s.setPlanReview);
    const activePath = useCode((s) => s.activePath);
    const selection = useCode((s) => s.selection);
    const pinned = useCode((s) => s.pinned);
    const { data: models } = useModels();
    const qc = useQueryClient();
    const cancel = useMutation({
      mutationFn: () => codeApi.cancel(runId!),
      onSuccess: () => void qc.invalidateQueries({ queryKey: codeKeys.runs(workspace.id) }),
    });
    const submit = () => {
      const t = text.trim();
      if (!t || running) return;
      onSubmit(t, model);
      setText('');
    };
    const sel = selection && selection.path === activePath ? selection : null;
    return (
      <div className="shrink-0 border-t border-line/70 p-2.5">
        <AnimatePresence>
          {(activePath || pinned.length > 0) && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-1.5 flex flex-wrap gap-1">
              {activePath && (
                <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 font-mono text-[10.5px] text-muted" title="Active file">
                  <FileCode2 className="size-3 shrink-0" />
                  <span className="truncate">
                    {activePath.split('/').pop()}
                    {sel ? `:${sel.startLine}-${sel.endLine}` : ''}
                  </span>
                </span>
              )}
              {pinned.map((p) => (
                <span key={p} className="inline-flex items-center gap-1 rounded-full bg-violet-soft/70 px-2 py-0.5 font-mono text-[10.5px] text-accent" title={p}>
                  <Pin className="size-2.5" /> {p.split('/').pop()}
                </span>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <div className="rounded-2xl border border-line bg-surface/90 focus-within:border-accent/40">
          <textarea
            ref={area}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={mode === 'restricted' ? 'Ask about the code (read-only)…' : 'Ask or describe a change…'}
            className="block max-h-48 min-h-[52px] w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] leading-5 text-ink outline-none placeholder:text-faint"
            data-testid="agent-input"
          />
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <Tooltip content={APPROVAL_MODES.find((m) => m.id === mode)?.description ?? ''} side="top">
              <select
                value={mode}
                onChange={(e) => setMode(workspace.id, e.target.value as ApprovalMode)}
                className="h-6 rounded-full bg-violet-soft/60 px-2 text-[11px] font-medium text-accent outline-none"
                aria-label="Approval mode"
                data-testid="approval-mode"
              >
                {APPROVAL_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Tooltip>
            <Tooltip content="Plan first: review and edit the agent's plan before it changes anything" side="top">
              <button
                onClick={() => setPlanFirst(workspace.id, !planFirst)}
                disabled={mode === 'restricted'}
                aria-pressed={planFirst}
                className={cn(
                  'flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition disabled:opacity-40',
                  planFirst ? 'bg-violet-soft/70 text-accent' : 'bg-surface text-muted hover:text-ink',
                )}
                data-testid="plan-first"
              >
                <ListChecks className="size-3" /> Plan first
              </button>
            </Tooltip>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="h-6 max-w-32 truncate rounded-full bg-surface px-2 text-[11px] text-muted outline-none" aria-label="Model">
              <option value="auto">Auto model</option>
              {models?.data
                .filter((m) => m.available && m.capabilities?.tools !== false)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
            </select>
            <div className="ml-auto">
              {running ? (
                <Button variant="glass" size="icon-sm" className="size-7" onClick={() => runId && cancel.mutate()} aria-label="Stop" data-testid="agent-stop">
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button variant="primary" size="icon-sm" className="size-7" disabled={!text.trim()} onClick={submit} aria-label="Send" data-testid="agent-send">
                  <ArrowUp className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  },
);
