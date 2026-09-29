import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight, CircleCheck, CircleDashed, CircleX, Hourglass, ScanSearch } from 'lucide-react';
import type { Run } from '@neuroflow/contracts';
import { cn, formatDuration } from '@/lib/utils';
import { modelName, STRATEGY_LABEL, type RunView, type TimelineStep } from '@/lib/run-view';
import { Sparkle } from '@/components/ui/sparkle';

const KIND_TONE: Record<TimelineStep['kind'], string> = {
  run: 'bg-violet-soft text-accent',
  router: 'bg-violet-soft text-accent',
  agent: 'bg-sky-soft text-sky-600',
  model: 'bg-sky-soft text-sky-600',
  tool: 'bg-mint-soft text-emerald-600',
  memory: 'bg-peach-soft text-orange-500',
  evaluation: 'bg-rose-soft text-rose-500',
  approval: 'bg-peach-soft text-orange-500',
  cognitive: 'bg-violet-soft text-accent-deep',
};

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Compact, human-readable execution status built exclusively from backend events.
 * Collapsed by default; expands into the step timeline.
 */
export function ExecutionTrace({
  run,
  view,
  onExpand,
  onInspect,
  minimal,
}: {
  run: Run;
  view: RunView | null;
  onExpand?(): void;
  onInspect(): void;
  minimal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = view?.status ?? run.status;
  const active = status === 'queued' || status === 'running';
  const now = useNow(active);
  const started = view?.startedAt ?? (run.startedAt ? Date.parse(run.startedAt) : undefined);
  const ended = view?.endedAt ?? (run.completedAt ? Date.parse(run.completedAt) : undefined);
  const elapsed = started ? (ended ?? now) - started : undefined;
  const plan = view?.plan ?? run.executionPlan ?? undefined;
  const phase =
    view?.phase ??
    (status === 'completed' ? 'Completed' : status === 'failed' ? 'Failed' : status === 'cancelled' ? 'Stopped' : 'Starting task');

  const meta = [
    plan && STRATEGY_LABEL[plan.agentStrategy],
    plan && [...new Set(plan.models.map((m) => modelName(m.model)))].slice(0, 2).join(' + '),
    elapsed !== undefined && formatDuration(elapsed),
  ].filter(Boolean);

  const toggle = () => {
    if (!open) onExpand?.();
    setOpen(!open);
  };

  return (
    <div className="mb-3" data-testid="execution-trace" data-status={status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button onClick={toggle} className="group flex min-w-0 items-center gap-2 rounded-full py-1 pr-2 text-left" aria-expanded={open}>
          {active ? (
            <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 3.2, ease: 'linear' }} className="flex">
              <Sparkle className="size-4" />
            </motion.span>
          ) : status === 'completed' ? (
            <CircleCheck className="size-4 text-emerald-500" />
          ) : status === 'failed' ? (
            <CircleX className="size-4 text-rose-500" />
          ) : (
            <CircleDashed className="size-4 text-faint" />
          )}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={phase}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className={cn('truncate text-[13px] font-medium', active ? 'shimmer-text' : 'text-muted')}
              data-testid="run-phase"
            >
              {phase}
            </motion.span>
          </AnimatePresence>
          {!minimal && <ChevronRight className={cn('size-3.5 text-faint transition-transform', open && 'rotate-90')} />}
        </button>
        {!minimal && meta.length > 0 && <span className="text-xs text-faint">{meta.join(' · ')}</span>}
        {!minimal && view && view.toolsUsed.length > 0 && (
          <span className="flex gap-1">
            {view.toolsUsed.map((t) => (
              <span key={t} className="rounded-full bg-mint-soft px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                {t}
              </span>
            ))}
          </span>
        )}
        {!minimal && (
          <button onClick={onInspect} className="ml-auto flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-faint transition hover:bg-white/70 hover:text-accent">
            <ScanSearch className="size-3.5" /> Inspect
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && !minimal && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
          <ol className="ml-2.5 mt-2 border-l border-dashed border-line pl-4" data-testid="timeline">
            {(view?.steps ?? []).length === 0 && <li className="py-1 text-xs text-faint">Loading execution timeline…</li>}
            {view?.steps.map((s) => (
              <li key={s.key} className="relative flex items-center gap-2.5 py-1.5">
                <span className={cn('absolute -left-[21px] size-2 rounded-full ring-4 ring-white/80', s.status === 'active' ? 'bg-accent' : s.status === 'failed' ? 'bg-rose-400' : s.status === 'waiting' ? 'bg-orange-400' : 'bg-emerald-400')} />
                <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', KIND_TONE[s.kind])}>{s.kind}</span>
                <span className="text-[13px] text-ink-soft">{s.label}</span>
                {s.detail && <span className="truncate text-xs text-faint">{s.detail}</span>}
                <span className="ml-auto flex items-center gap-1 text-[11px] tabular-nums text-faint">
                  {s.status === 'waiting' && <Hourglass className="size-3" />}
                  {s.endedAt ? formatDuration(s.endedAt - s.startedAt) : s.status === 'active' ? formatDuration(now - s.startedAt) : ''}
                </span>
              </li>
            ))}
          </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
