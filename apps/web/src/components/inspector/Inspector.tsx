import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  Bot,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  Database,
  Hash,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { cn, formatCost, formatDuration, formatTime, formatTokens, relativeTime, shortId } from '@/lib/utils';
import { ExecutionGraph } from './ExecutionGraph';
import { modelName, STRATEGY_LABEL } from '@/lib/run-view';
import { useRunDetails, useRunView } from '@/hooks/queries';
import { useUi } from '@/stores/ui';
import { Button } from '@/components/ui/button';

export function Inspector({ runId }: { runId: string | null }) {
  const close = useUi((s) => s.toggleInspector);
  const { data, isLoading } = useRunDetails(runId);
  const { view } = useRunView(runId, false);

  return (
    <aside className="glass flex h-full w-[380px] shrink-0 flex-col overflow-hidden rounded-[28px]" data-testid="inspector" aria-label="Execution inspector">
      <div className="flex items-center justify-between px-5 pb-2 pt-4">
        <div>
          <div className="text-sm font-semibold text-ink">Execution inspector</div>
          <div className="text-[11px] text-muted">Metadata only — never hidden reasoning</div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => close()} aria-label="Close inspector">
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-5">
        {!runId && <Empty>Run something, then open the inspector to see how it executed.</Empty>}
        {runId && isLoading && <Empty>Loading run…</Empty>}
        {data && <InspectorBody data={data} view={view} />}
      </div>
    </aside>
  );
}

function InspectorBody({ data, view }: { data: NonNullable<ReturnType<typeof useRunDetails>['data']>; view: ReturnType<typeof useRunView>['view'] }) {
  const { run, details } = data;
  const plan = run.executionPlan;
  const duration = run.startedAt ? (run.completedAt ? Date.parse(run.completedAt) : Date.now()) - Date.parse(run.startedAt) : null;
  const tokens = run.usage?.totalTokens ?? details.modelCalls.reduce((n, m) => n + (m.promptTokens ?? 0) + (m.completionTokens ?? 0), 0);
  const lastEval = details.evaluations.at(-1);
  const maxLatency = Math.max(1, ...details.modelCalls.map((m) => m.latencyMs));
  const retries = details.modelCalls.reduce((n, m) => n + Math.max(0, m.attempts - 1), 0);
  const fallbacks = details.modelCalls.filter((m) => m.fallbackFrom).length;
  const cost = run.usage?.costUsd ?? sumCost(details.modelCalls);
  const timeouts =
    details.modelCalls.filter((m) => /timeout|exceeded|within d+ms/i.test(m.error ?? '')).length +
    details.toolCalls.filter((t) => t.status === 'timeout').length;
  const queuedMs = run.startedAt ? Date.parse(run.startedAt) - Date.parse(run.createdAt) : null;

  return (
    <>
      {/* header card — lavender→blue gradient like the reference feature cards */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-[22px] bg-gradient-to-br from-[#d9d6fb] via-[#dfe4fd] to-[#cfe0fb] p-4 dark:from-[#2b2552] dark:via-[#232347] dark:to-[#1c2a48]"
      >
        <div className="absolute -right-6 -top-6 size-24 rounded-full bg-surface/40 blur-xl" />
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-surface/80 text-accent shadow-sm">
            <Activity className="size-4.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">Run {shortId(run.id)}</div>
            <div className="text-[11px] text-ink-soft/80">
              {run.mode === 'cognitive' ? 'Cognitive mode' : 'Standard mode'} · attempt {run.attempt || 1}
            </div>
          </div>
          <StatusPill status={run.status} />
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface/60">
          <div className={cn('h-full rounded-full bg-gradient-to-r from-violet-400 to-sky-400', run.status === 'running' && 'animate-pulse')} style={{ width: run.status === 'queued' ? '8%' : run.status === 'running' ? '60%' : '100%' }} />
        </div>
      </motion.div>

      {/* stat row — like "+12K · 98% · +45%" */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-3 rounded-[20px] border border-surface/80 bg-surface/60 p-3">
        <Stat icon={Clock} value={formatDuration(duration)} label="Duration" />
        <Stat icon={Hash} value={formatTokens(tokens || null)} label="Tokens" />
        <Stat icon={Coins} value={formatCost(cost)} label="Est. cost" />
        <Stat icon={CheckCircle2} value={lastEval?.score != null ? `${Math.round(lastEval.score * 100)}%` : (lastEval?.verdict ?? '—')} label="Evaluation" />
      </div>

      <Card icon={CalendarClock} title="Run" tone="violet">
        <Rows
          rows={[
            ['Created', formatTime(run.createdAt)],
            ['Started', run.startedAt ? formatTime(run.startedAt) : '—'],
            ['Completed', run.completedAt ? formatTime(run.completedAt) : '—'],
            ['Queue time', formatDuration(queuedMs)],
          ]}
        />
      </Card>

      {details.agents.length + details.modelCalls.length > 0 && <ExecutionGraph details={details} plan={plan} />}

      {plan && (
        <Card icon={Sparkles} title="Strategy" tone="violet">
          <Rows
            rows={[
              ['Task class', plan.taskClass],
              ['Execution', STRATEGY_LABEL[plan.agentStrategy] ?? plan.agentStrategy],
              ['Models', plan.modelStrategy === 'multi' ? 'Multi-model' : 'Single model'],
              ['Reasoning budget', plan.reasoningBudget],
              ['Complexity', `${Math.round(plan.complexity * 100)}%`],
            ]}
          />
          {plan.rationale.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-surface/70 pt-2">
              {plan.rationale.map((r) => (
                <li key={r} className="text-[11px] leading-4 text-muted">
                  • {r}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {plan?.cognitive && (
        <Card icon={BrainCircuit} title="Cognitive policy" tone="rose">
          <Rows
            rows={[
              ['Workload', plan.cognitive.workload],
              ['Response density', plan.cognitive.responseDensity],
              ['Task chunking', plan.cognitive.taskChunking],
              ['UI density', plan.cognitive.uiDensity],
              ['Strategy cap', STRATEGY_LABEL[plan.cognitive.maxAutoStrategy] ?? plan.cognitive.maxAutoStrategy],
            ]}
          />
        </Card>
      )}

      <Card icon={Cpu} title={`Models · ${details.modelCalls.length} call${details.modelCalls.length === 1 ? '' : 's'}`} tone="sky">
        {details.modelCalls.length === 0 && <Muted>No model calls yet.</Muted>}
        <div className="space-y-2.5">
          {details.modelCalls.map((m, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 text-xs">
                <span className="rounded-full bg-surface/80 px-2 py-0.5 text-[10px] font-semibold uppercase text-sky-700">{m.provider}</span>
                <span className="truncate font-medium text-ink">{modelName(m.model)}</span>
                <span className="text-faint">{m.role}</span>
                <span className="ml-auto tabular-nums text-muted">{formatDuration(m.latencyMs)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface/70">
                <div
                  className={cn('h-full rounded-full', m.status === 'completed' ? 'bg-gradient-to-r from-sky-300 to-violet-400' : 'bg-rose-300')}
                  style={{ width: `${Math.max(6, (m.latencyMs / maxLatency) * 100)}%` }}
                />
              </div>
              <div className="mt-1 flex gap-3 text-[10px] text-faint">
                {m.firstTokenMs != null && <span>first token {formatDuration(m.firstTokenMs)}</span>}
                {m.completionTokens != null && <span>{m.completionTokens} out tokens</span>}
                {m.attempts > 1 && <span className="text-orange-500">{m.attempts} attempts</span>}
                {m.fallbackFrom && <span className="text-orange-500">fallback from {modelName(m.fallbackFrom)}</span>}
                {m.error && <span className="text-rose-500">{m.status}</span>}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {details.agents.length > 0 && (
        <Card icon={Bot} title="Agents" tone="violet">
          <div className="space-y-1.5">
            {details.agents.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-xs">
                <Dot status={a.status} />
                <span className="font-medium capitalize text-ink">{a.agentId}</span>
                <span className="truncate text-faint">{modelName(a.model)}</span>
                <span className="ml-auto tabular-nums text-muted">
                  {a.completedAt ? formatDuration(Date.parse(a.completedAt) - Date.parse(a.startedAt)) : '…'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card icon={Wrench} title="Tools" tone="mint">
        {details.toolCalls.length === 0 ? (
          <Muted>No tools were needed.</Muted>
        ) : (
          <div className="space-y-1.5">
            {details.toolCalls.map((t) => (
              <div key={t.toolCallId} className="flex items-center gap-2 text-xs">
                <Dot status={t.status} />
                <span className="font-medium text-ink">{t.name}</span>
                <span className="text-faint">{t.status}</span>
                {t.approvalStatus && t.approvalStatus !== 'not_required' && (
                  <span className="rounded-full bg-peach-soft px-1.5 text-[10px] text-orange-600">{t.approvalStatus}</span>
                )}
                <span className="ml-auto tabular-nums text-muted">{formatDuration(t.durationMs)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card icon={Database} title="Memory" tone="peach">
        {view?.memoryQueries.length ? (
          view.memoryQueries.map((q, i) => (
            <div key={i} className="mb-2 text-xs last:mb-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-ink-soft">“{q.query}”</span>
                <span className="ml-auto shrink-0 text-muted">
                  {q.count} result{q.count === 1 ? '' : 's'}
                </span>
              </div>
              {q.items.map((m) => (
                <div key={m.id} className="mt-1 flex flex-wrap items-center gap-1.5 pl-2 text-[10px] text-faint" data-testid="memory-source">
                  <span>{m.source === 'agent' ? 'saved by NeuroFlow' : m.source === 'import' ? 'imported' : 'added by you'}</span>
                  <span>· {relativeTime(m.createdAt)}</span>
                  {m.tags.map((t) => (
                    <span key={t} className="rounded-full bg-surface/80 px-1.5 text-accent">
                      {t}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ))
        ) : (
          <Muted>Memory was not queried.</Muted>
        )}
      </Card>

      <Card icon={ShieldCheck} title="Evaluation" tone="rose">
        {details.evaluations.length === 0 ? (
          <Muted>Not evaluated yet.</Muted>
        ) : (
          details.evaluations.map((e, i) => (
            <div key={i} className="mb-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', e.verdict === 'passed' ? 'bg-mint-soft text-emerald-700' : 'bg-rose-soft text-rose-600')}>
                  {e.verdict.replace('_', ' ')}
                </span>
                <span className="text-faint">
                  {e.kind} · iteration {e.iteration}
                </span>
                {e.score != null && <span className="ml-auto tabular-nums text-muted">{Math.round(e.score * 100)}%</span>}
              </div>
              {e.issues.map((iss) => (
                <div key={iss} className="mt-1 text-[11px] text-muted">
                  • {iss}
                </div>
              ))}
            </div>
          ))
        )}
      </Card>

      <Card icon={RefreshCw} title="Reliability" tone="sky">
        <Rows
          rows={[
            ['Retries', String(retries)],
            ['Fallbacks', String(fallbacks)],
            ['Timeouts', String(timeouts)],
            ['Attempt', String(run.attempt || 1)],
            ...(plan
              ? ([
                  ['Model calls', `${details.modelCalls.length} / ${plan.budgets.maxModelCalls}`],
                  ['Tool calls', `${details.toolCalls.length} / ${plan.budgets.maxToolCalls ?? '—'}`],
                  ['Time budget', formatDuration(plan.budgets.maxDurationMs)],
                  ...(plan.budgets.maxCostUsd !== undefined ? [['Cost budget', formatCost(plan.budgets.maxCostUsd)]] : []),
                ] as Array<[string, string]>)
              : []),
            ...(run.error ? ([['Failure', `${run.error.code}${run.error.stage ? ` @ ${run.error.stage}` : ''}`]] as Array<[string, string]>) : []),
          ]}
        />
      </Card>
    </>
  );
}

function sumCost(calls: Array<{ costUsd: number | null }>): number | null {
  if (calls.length === 0 || calls.some((c) => c.costUsd == null)) return null;
  return calls.reduce((n, c) => n + (c.costUsd ?? 0), 0);
}

const TONES = {
  violet: 'from-[#f1ecff] dark:from-[#251e43] to-surface/60 text-accent',
  sky: 'from-[#e6effd] dark:from-[#1b2742] to-surface/60 text-sky-600',
  mint: 'from-[#e1f6ef] dark:from-[#15302b] to-surface/60 text-emerald-600',
  rose: 'from-[#fdeaf2] dark:from-[#371d2d] to-surface/60 text-rose-500',
  peach: 'from-[#fdf0e3] dark:from-[#35271b] to-surface/60 text-orange-500',
};

function Card({ icon: Icon, title, tone, children }: { icon: typeof Cpu; title: string; tone: keyof typeof TONES; children: ReactNode }) {
  return (
    <section className={cn('rounded-[20px] border border-surface/80 bg-gradient-to-br p-3.5', TONES[tone])}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-surface/85 shadow-sm">
          <Icon className="size-3.5" />
        </span>
        <span className="text-[13px] font-semibold text-ink">{title}</span>
      </div>
      <div className="text-ink-soft">{children}</div>
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="space-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-3 text-xs">
          <dt className="text-muted">{k}</dt>
          <dd className="font-medium capitalize text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Stat({ icon: Icon, value, label }: { icon: typeof Cpu; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 text-accent" />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold tabular-nums text-ink">{value}</div>
        <div className="text-[10px] text-muted">{label}</div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'completed' ? 'bg-mint-soft text-emerald-700' : status === 'failed' ? 'bg-rose-soft text-rose-600' : status === 'cancelled' ? 'bg-line text-muted' : 'bg-surface/80 text-accent';
  return <span className={cn('ml-auto rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize', tone)}>{status}</span>;
}

function Dot({ status }: { status: string }) {
  const color = ['completed', 'success'].includes(status) ? 'bg-emerald-400' : ['running', 'pending_approval'].includes(status) ? 'bg-accent' : 'bg-rose-400';
  return <span className={cn('size-1.5 shrink-0 rounded-full', color)} />;
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted">{children}</p>;
const Empty = ({ children }: { children: ReactNode }) => (
  <div className="rounded-[20px] border border-dashed border-line bg-surface/40 p-6 text-center text-xs leading-5 text-muted">{children}</div>
);
