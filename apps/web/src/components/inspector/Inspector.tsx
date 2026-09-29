import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  Database,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { cn, formatDuration, formatTokens, shortId } from '@/lib/utils';
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

  return (
    <>
      {/* header card — lavender→blue gradient like the reference feature cards */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-[22px] bg-gradient-to-br from-[#d9d6fb] via-[#dfe4fd] to-[#cfe0fb] p-4"
      >
        <div className="absolute -right-6 -top-6 size-24 rounded-full bg-white/40 blur-xl" />
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-white/80 text-accent shadow-sm">
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
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/60">
          <div className={cn('h-full rounded-full bg-gradient-to-r from-violet-400 to-sky-400', run.status === 'running' && 'animate-pulse')} style={{ width: run.status === 'queued' ? '8%' : run.status === 'running' ? '60%' : '100%' }} />
        </div>
      </motion.div>

      {/* stat row — like "+12K · 98% · +45%" */}
      <div className="grid grid-cols-3 gap-2 rounded-[20px] border border-white/80 bg-white/60 p-3">
        <Stat icon={Clock} value={formatDuration(duration)} label="Duration" />
        <Stat icon={Coins} value={formatTokens(tokens || null)} label="Tokens" />
        <Stat icon={CheckCircle2} value={lastEval?.score != null ? `${Math.round(lastEval.score * 100)}%` : (lastEval?.verdict ?? '—')} label="Evaluation" />
      </div>

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
            <ul className="mt-2 space-y-1 border-t border-white/70 pt-2">
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
                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase text-sky-700">{m.provider}</span>
                <span className="truncate font-medium text-ink">{modelName(m.model)}</span>
                <span className="text-faint">{m.role}</span>
                <span className="ml-auto tabular-nums text-muted">{formatDuration(m.latencyMs)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/70">
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
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="truncate text-ink-soft">“{q.query}”</span>
              <span className="ml-auto text-muted">{q.count} result{q.count === 1 ? '' : 's'}</span>
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
            ['Attempt', String(run.attempt || 1)],
            ...(run.error ? ([['Failure', `${run.error.code}${run.error.stage ? ` @ ${run.error.stage}` : ''}`]] as Array<[string, string]>) : []),
          ]}
        />
      </Card>
    </>
  );
}

const TONES = {
  violet: 'from-[#f1ecff] to-white/60 text-accent',
  sky: 'from-[#e6effd] to-white/60 text-sky-600',
  mint: 'from-[#e1f6ef] to-white/60 text-emerald-600',
  rose: 'from-[#fdeaf2] to-white/60 text-rose-500',
  peach: 'from-[#fdf0e3] to-white/60 text-orange-500',
};

function Card({ icon: Icon, title, tone, children }: { icon: typeof Cpu; title: string; tone: keyof typeof TONES; children: ReactNode }) {
  return (
    <section className={cn('rounded-[20px] border border-white/80 bg-gradient-to-br p-3.5', TONES[tone])}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-white/85 shadow-sm">
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
    status === 'completed' ? 'bg-mint-soft text-emerald-700' : status === 'failed' ? 'bg-rose-soft text-rose-600' : status === 'cancelled' ? 'bg-line text-muted' : 'bg-white/80 text-accent';
  return <span className={cn('ml-auto rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize', tone)}>{status}</span>;
}

function Dot({ status }: { status: string }) {
  const color = ['completed', 'success'].includes(status) ? 'bg-emerald-400' : ['running', 'pending_approval'].includes(status) ? 'bg-accent' : 'bg-rose-400';
  return <span className={cn('size-1.5 shrink-0 rounded-full', color)} />;
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted">{children}</p>;
const Empty = ({ children }: { children: ReactNode }) => (
  <div className="rounded-[20px] border border-dashed border-line bg-white/40 p-6 text-center text-xs leading-5 text-muted">{children}</div>
);
