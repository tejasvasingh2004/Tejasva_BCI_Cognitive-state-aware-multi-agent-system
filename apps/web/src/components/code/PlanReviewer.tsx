import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, ListChecks, Plus, RotateCcw, Square, Trash2 } from 'lucide-react';
import { codeApi } from '@/lib/code-api';
import type { PlanReview } from '@/lib/code-run-view';
import { cn } from '@/lib/utils';
import { useToasts } from '@/stores/toasts';
import { Button } from '@/components/ui/button';
import { errorMessage, inputClass } from './shared';

/**
 * Plan Review: the agent's plan is held until you approve it (as is or edited), ask for a revised
 * plan with feedback, or stop. Nothing in the repository changes before approval.
 */
export function PlanReviewer({ runId, plan }: { runId: string; plan: PlanReview }) {
  const [steps, setSteps] = useState(plan.steps);
  const [feedback, setFeedback] = useState('');
  const [mode, setMode] = useState<'edit' | 'revise'>('edit');
  const pushToast = useToasts((s) => s.push);
  useEffect(() => {
    setSteps(plan.steps);
    setFeedback('');
    setMode('edit');
  }, [plan.planId, plan.steps]);

  const cleaned = useMemo(() => steps.map((s) => s.trim()).filter(Boolean), [steps]);
  const edited = JSON.stringify(cleaned) !== JSON.stringify(plan.steps);
  const valid = cleaned.length > 0 && cleaned.length <= 12 && cleaned.every((s) => s.length >= 3 && s.length <= 300);

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'revise' | 'reject') =>
      codeApi.decidePlan(
        runId,
        decision === 'approve'
          ? { decision, planId: plan.planId, ...(edited ? { steps: cleaned } : {}) }
          : decision === 'revise'
            ? { decision, planId: plan.planId, feedback: feedback.trim() }
            : { decision, planId: plan.planId, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) },
      ),
    onError: (err) => pushToast({ tone: 'error', title: 'Decision not recorded', body: errorMessage(err) }),
  });

  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const next = [...s];
      const j = i + d;
      if (j < 0 || j >= next.length) return s;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const minutesLeft = Math.max(0, Math.round((Date.parse(plan.expiresAt) - Date.now()) / 60_000));

  return (
    <div className="overflow-hidden rounded-2xl border border-accent/30 bg-surface/80 shadow-soft" data-testid="plan-review">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <ListChecks className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-ink">Review the plan before the agent starts</div>
          <div className="text-[11px] text-muted">
            {plan.revision > 1 ? `Revision ${plan.revision} · ` : ''}Nothing changes in the repository until you approve{minutesLeft ? ` · expires in ${minutesLeft} min` : ''}
          </div>
        </div>
      </div>
      {plan.summary && <p className="border-t border-line px-3 py-2 text-[12.5px] leading-5 text-ink-soft">{plan.summary}</p>}
      <ol className="flex flex-col gap-1.5 border-t border-line p-3">
        {steps.map((s, i) => (
          <li key={i} className="group flex items-start gap-1.5">
            <span className="mt-1.5 w-4 shrink-0 text-right text-[11px] text-faint">{i + 1}.</span>
            <textarea
              value={s}
              rows={Math.min(3, Math.max(1, Math.ceil(s.length / 48)))}
              onChange={(e) => setSteps((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
              className={cn(inputClass, 'min-h-0 resize-none px-2 py-1 text-[12.5px] leading-5')}
              aria-label={`Step ${i + 1}`}
              data-testid={`plan-step-${i}`}
            />
            <div className="flex shrink-0 flex-col opacity-60 group-hover:opacity-100">
              <button className="rounded p-0.5 text-faint hover:text-ink disabled:opacity-30" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                <ArrowUp className="size-3" />
              </button>
              <button className="rounded p-0.5 text-faint hover:text-ink disabled:opacity-30" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">
                <ArrowDown className="size-3" />
              </button>
            </div>
            <button className="mt-1 rounded p-0.5 text-faint opacity-60 hover:text-rose-500 group-hover:opacity-100" onClick={() => setSteps((all) => all.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
        <button
          className="ml-5 flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-accent hover:bg-violet-soft/50 disabled:opacity-40"
          onClick={() => setSteps((s) => [...s, ''])}
          disabled={steps.length >= 12}
          data-testid="plan-add-step"
        >
          <Plus className="size-3" /> Add step
        </button>
      </ol>
      {mode === 'revise' && (
        <div className="border-t border-line p-3">
          <textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change? The agent writes a new plan from your feedback."
            className={cn(inputClass, 'min-h-16 text-[12.5px] leading-5')}
            data-testid="plan-feedback"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-line px-3 py-2">
        <Button variant="ghost" size="sm" disabled={decide.isPending} onClick={() => decide.mutate('reject')} data-testid="plan-stop">
          <Square className="size-3" /> Stop
        </Button>
        {mode === 'revise' ? (
          <Button variant="outline" size="sm" disabled={decide.isPending || feedback.trim().length < 3} onClick={() => decide.mutate('revise')} data-testid="plan-send-feedback">
            <RotateCcw className="size-3.5" /> Revise plan
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={decide.isPending} onClick={() => setMode('revise')} data-testid="plan-request-changes">
            <RotateCcw className="size-3.5" /> Request changes
          </Button>
        )}
        <Button variant="primary" size="sm" disabled={decide.isPending || !valid} onClick={() => decide.mutate('approve')} data-testid="plan-approve">
          <Check className="size-3.5" /> {edited ? 'Approve edited plan' : 'Approve plan'}
        </Button>
      </div>
    </div>
  );
}
