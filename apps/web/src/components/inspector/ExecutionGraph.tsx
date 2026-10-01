import type { ExecutionPlan } from '@neuroflow/contracts';
import { GitBranch } from 'lucide-react';
import type { RunDetails } from '@/lib/api';
import { cn, formatDuration } from '@/lib/utils';
import { modelName, STRATEGY_LABEL } from '@/lib/run-view';

type Details = RunDetails['details'];

const dot = (status: string) =>
  ['completed', 'success', 'passed'].includes(status)
    ? 'bg-emerald-400'
    : ['running', 'pending_approval'].includes(status)
      ? 'bg-accent'
      : status === 'needs_refinement'
        ? 'bg-amber-400'
        : 'bg-rose-400';

function Node({ status, label, meta, depth = 0 }: { status: string; label: string; meta?: string; depth?: number }) {
  return (
    <li className="relative flex items-center gap-2 py-1 text-xs" style={{ paddingLeft: depth * 14 }}>
      {depth > 0 && <span className="absolute top-0 h-1/2 border-l border-b border-line" style={{ left: depth * 14 - 9, width: 7 }} />}
      <span className={cn('size-1.5 shrink-0 rounded-full', dot(status))} />
      <span className="truncate text-ink">{label}</span>
      {meta && <span className="ml-auto shrink-0 tabular-nums text-faint">{meta}</span>}
    </li>
  );
}

/**
 * Execution graph built from persisted execution records: router → agents → their model and tool
 * calls → evaluation. Metadata only — never prompts or hidden reasoning.
 */
export function ExecutionGraph({ details, plan }: { details: Details; plan: ExecutionPlan | null }) {
  const unattributed = details.modelCalls.filter((m) => !m.agentExecutionId);
  return (
    <section className="rounded-[20px] border border-surface/80 bg-surface/50 p-3.5" data-testid="execution-graph">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-surface/85 text-accent shadow-sm">
          <GitBranch className="size-3.5" />
        </span>
        <span className="text-[13px] font-semibold text-ink">Execution graph</span>
      </div>
      <ol>
        <Node status="completed" label={`Router → ${plan ? (STRATEGY_LABEL[plan.agentStrategy] ?? plan.agentStrategy) : '…'}`} />
        {details.agents.map((a) => {
          const models = details.modelCalls.filter((m) => m.agentExecutionId === a.id);
          const tools = details.toolCalls.filter((t) => t.agentExecutionId === a.id);
          const steps = [
            ...models.map((m) => ({ at: m.createdAt, node: <Node key={`m${m.createdAt}${m.model}`} depth={2} status={m.status} label={`model ${modelName(m.model)}`} meta={formatDuration(m.latencyMs)} /> })),
            ...tools.map((t) => ({ at: t.createdAt, node: <Node key={`t${t.toolCallId}`} depth={2} status={t.status} label={`tool ${t.name}`} meta={formatDuration(t.durationMs)} /> })),
          ].sort((x, y) => x.at.localeCompare(y.at));
          return (
            <li key={a.id}>
              <ol>
                <Node
                  depth={1}
                  status={a.status}
                  label={`agent ${a.agentId}`}
                  meta={a.completedAt ? formatDuration(Date.parse(a.completedAt) - Date.parse(a.startedAt)) : '…'}
                />
                {steps.map((s) => s.node)}
              </ol>
            </li>
          );
        })}
        {unattributed.map((m, i) => (
          <Node key={`u${i}`} depth={1} status={m.status} label={`${m.role} · ${modelName(m.model)}`} meta={formatDuration(m.latencyMs)} />
        ))}
        {details.evaluations.map((e, i) => (
          <Node key={`e${i}`} depth={1} status={e.verdict} label={`evaluation (${e.kind}) · ${e.verdict.replace('_', ' ')}`} />
        ))}
      </ol>
    </section>
  );
}
