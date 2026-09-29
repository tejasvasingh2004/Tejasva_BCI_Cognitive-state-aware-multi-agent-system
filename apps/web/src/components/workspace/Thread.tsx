import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, RotateCcw, ShieldAlert, Square } from 'lucide-react';
import type { ConversationDetail, Run, StoredMessage } from '@neuroflow/contracts';
import { cn } from '@/lib/utils';
import { useApprove, useRunView } from '@/hooks/queries';
import { useUi } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Sparkle } from '@/components/ui/sparkle';
import { ExecutionTrace } from './ExecutionTrace';
import { Markdown } from './Markdown';
import type { PendingApproval } from '@/lib/run-view';

type Turn = { run: Run; user: StoredMessage[]; assistant?: StoredMessage };

function buildTurns(detail: ConversationDetail): Turn[] {
  return detail.runs.map((run) => ({
    run,
    user: detail.messages.filter((m) => m.runId === run.id && m.role === 'user'),
    assistant: detail.messages.find((m) => m.runId === run.id && m.role === 'assistant'),
  }));
}

export function Thread({
  detail,
  pendingText,
  onRetry,
  uiDensity,
}: {
  detail: ConversationDetail;
  pendingText: string | null;
  onRetry(text: string): void;
  uiDensity: 'full' | 'reduced' | 'minimal';
}) {
  const turns = useMemo(() => buildTurns(detail), [detail]);
  const bottom = useRef<HTMLDivElement>(null);
  const lastRun = turns.at(-1)?.run;
  const { view: lastView } = useRunView(lastRun?.id ?? null, true);

  // Follow the stream like an editor terminal: stay pinned to the bottom while output arrives.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, pendingText, lastView?.text.length, lastView?.steps.length]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pb-10 pt-8">
      {turns.map((t, i) => (
        <div key={t.run.id} className="flex flex-col gap-5">
          {t.user.map((m) => (
            <UserBubble key={m.id} text={m.content} />
          ))}
          <AssistantTurn turn={t} isLast={i === turns.length - 1} onRetry={onRetry} uiDensity={uiDensity} />
        </div>
      ))}
      {pendingText && (
        <div className="flex flex-col gap-5">
          <UserBubble text={pendingText} />
          <div className="flex items-center gap-2 pl-11 text-[13px] text-muted">
            <Sparkle className="size-4" animated />
            <span className="shimmer-text font-medium">Starting task</span>
          </div>
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end" data-testid="user-message">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-[22px] rounded-br-md bg-gradient-to-br from-[#efe9fe] to-[#e3ebfd] px-4 py-2.5 text-[15px] leading-6 text-ink shadow-sm">
        {text}
      </div>
    </motion.div>
  );
}

function AssistantTurn({
  turn,
  isLast,
  onRetry,
  uiDensity,
}: {
  turn: Turn;
  isLast: boolean;
  onRetry(text: string): void;
  uiDensity: 'full' | 'reduced' | 'minimal';
}) {
  const { run, assistant } = turn;
  const running = run.status === 'queued' || run.status === 'running';
  const [wantTimeline, setWantTimeline] = useState(false);
  // Live runs stream events; finished runs load their timeline lazily when expanded or inspected.
  const { view } = useRunView(running || isLast || wantTimeline ? run.id : null, running);
  const inspect = useUi((s) => s.inspect);
  const status = view?.status ?? run.status;
  const text = view && (view.text || status === 'running') ? view.text : (assistant?.content ?? run.output ?? '');
  const streaming = status === 'running' || status === 'queued';
  const lastUserText = turn.user.at(-1)?.content ?? '';

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3" data-testid="assistant-turn" data-run-id={run.id}>
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-white shadow-soft">
        <Sparkle className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <ExecutionTrace
          run={run}
          view={view}
          minimal={uiDensity === 'minimal' && !streaming}
          onExpand={() => setWantTimeline(true)}
          onInspect={() => {
            setWantTimeline(true);
            inspect(run.id);
          }}
        />
        {view?.approvals.map((a) => <ApprovalCard key={a.toolCallId} runId={run.id} approval={a} />)}
        {text && <Markdown text={text} streaming={streaming} />}
        {status === 'failed' && (
          <div className="mt-3 flex items-start gap-3 rounded-2xl border border-rose-100 bg-rose-soft/70 p-3.5 text-sm text-rose-700" data-testid="run-error">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Something went wrong</div>
              <div className="mt-0.5 text-rose-600/90">{view?.error?.message ?? run.error?.message ?? 'The run failed.'}</div>
            </div>
            {isLast && lastUserText && (
              <Button size="sm" variant="outline" onClick={() => onRetry(lastUserText)}>
                <RotateCcw className="size-3.5" /> Retry
              </Button>
            )}
          </div>
        )}
        {status === 'cancelled' && (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted" data-testid="run-stopped">
            <Square className="size-3 fill-current" /> Stopped
            {isLast && lastUserText && (
              <button className="ml-2 flex items-center gap-1 text-accent hover:underline" onClick={() => onRetry(lastUserText)}>
                <RotateCcw className="size-3" /> Retry
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ApprovalCard({ runId, approval }: { runId: string; approval: PendingApproval }) {
  const approve = useApprove();
  const decide = (approved: boolean) => approve.mutate({ runId, toolCallId: approval.toolCallId, approved });
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className="mb-4 rounded-2xl border border-orange-100 bg-gradient-to-br from-peach-soft to-rose-soft/70 p-4"
      data-testid="approval-card"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <ShieldAlert className="size-4 text-orange-500" />
        NeuroFlow wants to run <code className="rounded-md bg-white/70 px-1.5 text-accent-deep">{approval.name}</code>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px]', approval.riskLevel === 'high' ? 'bg-rose-100 text-rose-600' : 'bg-orange-100 text-orange-600')}>
          {approval.riskLevel} risk
        </span>
      </div>
      <pre className="mt-3 max-h-32 overflow-auto rounded-xl bg-white/70 p-3 text-xs text-ink-soft">{JSON.stringify(approval.arguments, null, 2)}</pre>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="primary" disabled={approve.isPending} onClick={() => decide(true)}>
          Approve
        </Button>
        <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => decide(false)}>
          Decline
        </Button>
      </div>
    </motion.div>
  );
}
