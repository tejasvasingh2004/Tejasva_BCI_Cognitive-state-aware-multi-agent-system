import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, Code2, Gauge, Infinity as InfinityIcon, MessageSquare, Plug, Table2, Wallet } from 'lucide-react';
import { USAGE_WINDOWS, type UsageHistory, type UsageSource, type WorkspaceBudget, type WorkspaceUsage } from '@neuroflow/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { keys } from '@/hooks/queries';
import { cn, formatDuration } from '@/lib/utils';
import { navigateTo, useDocumentTitle } from '@/hooks/route';
import { Button } from '@/components/ui/button';
import { Logo, Sparkle } from '@/components/ui/sparkle';
import { AppSwitcher } from '@/components/layout/AppSwitcher';
import { errorMessage } from '@/components/code/shared';

type Window = (typeof USAGE_WINDOWS)[number];
type Metric = 'tokens' | 'cost' | 'runs';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');
const fmtCount = (n: number) => (n >= 10_000 ? compact.format(n) : whole.format(n));
/** Costs here are often fractions of a cent, so small values keep more precision than elsewhere. */
const fmtUsd = (v: number) => (v === 0 ? '$0.00' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const fmtDay = (iso: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en', { ...opts, timeZone: 'UTC' });

const SOURCES: Record<UsageSource, { label: string; icon: typeof Code2 }> = {
  chat: { label: 'Chat', icon: MessageSquare },
  code: { label: 'Code Agent', icon: Code2 },
  api: { label: 'API', icon: Plug },
};

/** Usage: plan limits, today's quota and what the workspace used over a window. */
export function UsagePage() {
  useDocumentTitle('Usage · NeuroFlow');
  const [days, setDays] = useState<Window>(30);
  const current = useQuery({ queryKey: ['usage'], queryFn: api.usage, refetchInterval: 30_000 });
  const history = useQuery({ queryKey: ['usage-history', days], queryFn: () => api.usageHistory(days), placeholderData: keepPreviousData });
  const budget = useQuery({ queryKey: keys.budget, queryFn: api.budget, refetchInterval: 30_000 });

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="glass flex h-14 shrink-0 items-center gap-3 rounded-[22px] px-4">
        <button onClick={() => navigateTo('/')} aria-label="NeuroFlow home">
          <Logo className="size-7" />
        </button>
        <div className="text-sm font-semibold text-ink">Usage</div>
        <AppSwitcher className="ml-4" />
      </header>
      <main className="glass min-h-0 flex-1 overflow-y-auto rounded-[24px]" data-testid="usage-page">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">Usage</h1>
            <p className="mt-1 text-sm text-muted">Your plan, today&apos;s limits and what this workspace used. Days are UTC; costs are estimates from provider prices.</p>
          </div>

          {/* Filters: one row above everything they scope. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-full bg-surface/60 p-0.5" role="radiogroup" aria-label="Time window">
              {USAGE_WINDOWS.map((w) => (
                <button
                  key={w}
                  role="radio"
                  aria-checked={days === w}
                  onClick={() => setDays(w)}
                  className={cn('h-7 rounded-full px-3 text-xs font-medium transition', days === w ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:text-ink')}
                  data-testid={`usage-window-${w}`}
                >
                  Last {w} days
                </button>
              ))}
            </div>
            {history.isFetching && !history.isLoading && <span className="text-[11px] text-faint">Updating…</span>}
          </div>

          {current.data && <TodayCard usage={current.data} />}
          {budget.data && <BudgetCard budget={budget.data} />}

          {history.isLoading ? (
            <div className="flex h-60 items-center justify-center">
              <Sparkle className="size-7" animated />
            </div>
          ) : history.error || !history.data ? (
            <div className="flex flex-col items-center gap-3 py-12 text-sm text-ink">
              {errorMessage(history.error, 'Could not load usage')}
              <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            // Refetching keeps the previous frame at reduced opacity: no skeleton, no layout jump.
            <div className={cn('flex flex-col gap-4 transition-opacity', history.isPlaceholderData && 'opacity-60')}>
              <History data={history.data} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Card({ title, icon: Icon, action, children, className }: { title: string; icon: typeof Code2; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-line bg-surface/50 p-5', className)}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-accent" />
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Spend against the workspace's daily and monthly dollar limits; admins edit the limits here. */
function BudgetCard({ budget }: { budget: WorkspaceBudget }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [monthly, setMonthly] = useState(budget.monthlyLimitUsd?.toString() ?? '');
  const [daily, setDaily] = useState(budget.dailyLimitUsd?.toString() ?? '');
  const [alert, setAlert] = useState(String(budget.alertPercent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parse = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 100) / 100);
  const values = { monthlyLimitUsd: parse(monthly), dailyLimitUsd: parse(daily), alertPercent: Math.round(Number(alert)) };
  const valid =
    [values.monthlyLimitUsd, values.dailyLimitUsd].every((v) => v === null || (Number.isFinite(v) && v > 0)) &&
    values.alertPercent >= 1 &&
    values.alertPercent <= 100;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      qc.setQueryData(keys.budget, await api.updateBudget(values));
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the limits');
    } finally {
      setSaving(false);
    }
  };
  const when = (iso: string) => new Date(iso).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <Card
      title="Spending limits"
      icon={Wallet}
      action={
        budget.canEdit && !editing ? (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} data-testid="budget-edit">
            Edit limits
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <div className="flex flex-col gap-3" data-testid="budget-form">
          <div className="grid gap-3 sm:grid-cols-3">
            <BudgetField label="Monthly limit (USD)" value={monthly} onChange={setMonthly} placeholder="No limit" testId="budget-monthly" />
            <BudgetField label="Daily limit (USD)" value={daily} onChange={setDaily} placeholder="No limit" testId="budget-daily" />
            <BudgetField label="Alert at (% of a limit)" value={alert} onChange={setAlert} placeholder="80" testId="budget-alert" />
          </div>
          <p className="text-xs text-muted">
            Runs are refused once a limit is reached, and running tasks stop before their next model call. Crossing the alert threshold is recorded in the
            audit log.
          </p>
          {error && (
            <p className="text-xs text-rose-500" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={!valid || saving} onClick={() => void save()} data-testid="budget-save">
              {saving ? 'Saving…' : 'Save limits'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <SpendMeter label="Today" spend={budget.spend.todayUsd} limit={budget.dailyLimitUsd} alertPercent={budget.alertPercent} resets={when(budget.resets.day)} testId="budget-today" />
          <SpendMeter label="This month" spend={budget.spend.monthUsd} limit={budget.monthlyLimitUsd} alertPercent={budget.alertPercent} resets={when(budget.resets.month)} testId="budget-month" />
        </div>
      )}
      {budget.spend.unpricedCallsThisMonth > 0 && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted">
          <AlertTriangle className="size-3.5 text-amber-500" />
          {whole.format(budget.spend.unpricedCallsThisMonth)} model calls this month used models without a known price and are not counted.
        </p>
      )}
    </Card>
  );
}

function BudgetField({ label, value, onChange, placeholder, testId }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; testId: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
      {label}
      <input
        className="h-9 rounded-xl border border-line bg-surface px-3 text-sm font-normal text-ink"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </label>
  );
}

function SpendMeter({ label, spend, limit, alertPercent, resets, testId }: { label: string; spend: number; limit: number | null; alertPercent: number; resets: string; testId: string }) {
  const share = limit ? Math.min(1, spend / limit) : 0;
  const level = limit && spend >= limit ? 'critical' : share * 100 >= alertPercent ? 'warning' : 'ok';
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-soft">{label}</span>
        <span className="text-xs text-muted">resets {resets}</span>
      </div>
      <div className="mt-1 text-3xl font-semibold tracking-tight text-ink">
        {fmtUsd(spend)}
        <span className="ml-1.5 text-sm font-normal text-muted">{limit ? `of ${fmtUsd(limit)}` : 'no limit'}</span>
      </div>
      {limit ? (
        <>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-violet-soft" role="meter" aria-label={`${label} spend`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={spend}>
            <div
              className={cn('h-full rounded-full transition-[width] duration-500', level === 'critical' ? 'bg-rose-500' : level === 'warning' ? 'bg-amber-500' : 'bg-accent')}
              style={{ width: `${Math.max(share * 100, spend > 0 ? 2 : 0)}%` }}
            />
          </div>
          {level === 'critical' && <p className="mt-2 text-xs text-rose-500">Limit reached: new runs are refused until it resets.</p>}
        </>
      ) : null}
    </div>
  );
}

function TodayCard({ usage }: { usage: WorkspaceUsage }) {
  const { limits, usage: u, plan } = usage;
  const share = limits.dailyTokens ? Math.min(1, u.tokensToday / limits.dailyTokens) : 0;
  const level = share >= 0.9 ? 'critical' : share >= 0.75 ? 'warning' : 'ok';
  const resets = new Date(u.resetsAt).toLocaleString('en', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  return (
    <Card title="Today" icon={Gauge} action={<span className="rounded-full bg-violet-soft px-2 py-0.5 text-[11px] font-semibold capitalize text-accent">{plan} plan</span>}>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div data-testid="usage-quota">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-medium text-ink-soft">Model tokens today</span>
            <span className="text-xs text-muted">resets {resets}</span>
          </div>
          <div className="mt-1 text-3xl font-semibold tracking-tight text-ink">
            {whole.format(u.tokensToday)}
            <span className="ml-1.5 text-sm font-normal text-muted">
              {limits.dailyTokens ? `of ${fmtCount(limits.dailyTokens)}` : 'no daily limit'}
            </span>
          </div>
          {limits.dailyTokens ? (
            <>
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-violet-soft"
                role="meter"
                aria-label="Daily token quota used"
                aria-valuemin={0}
                aria-valuemax={limits.dailyTokens}
                aria-valuenow={u.tokensToday}
              >
                <div
                  className={cn('h-full rounded-full transition-[width] duration-500', level === 'critical' ? 'bg-rose-500' : level === 'warning' ? 'bg-amber-500' : 'bg-accent')}
                  style={{ width: `${Math.max(share * 100, u.tokensToday ? 1 : 0)}%` }}
                />
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
                {level !== 'ok' && <AlertTriangle className={cn('size-3', level === 'critical' ? 'text-rose-500' : 'text-amber-500')} />}
                {Math.round(share * 100)}% used
                {level === 'critical' ? ' · new runs are refused at the limit' : level === 'warning' ? ' · approaching the daily limit' : ''}
              </p>
            </>
          ) : (
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
              <InfinityIcon className="size-3" /> Your plan has no daily token cap.
            </p>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs">
          <Limit label="Active runs" value={`${u.activeRuns} of ${limits.activeRunsPerWorkspace}`} />
          <Limit label="Running at once" value={String(limits.runningPerWorkspace)} />
          <Limit label="New runs / minute" value={String(limits.runsPerMinute)} />
          <Limit label="Requests / minute" value={String(limits.requestsPerMinute)} />
          <Limit label="Sandbox commands / minute" value={String(limits.commandsPerMinute)} />
          <Limit label="Active runs per user" value={String(limits.activeRunsPerUser)} />
        </dl>
      </div>
    </Card>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function History({ data }: { data: UsageHistory }) {
  const t = data.totals;
  const tokens = t.promptTokens + t.completionTokens;
  if (t.runs === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface/50 px-4 py-14 text-center">
        <BarChart3 className="size-7 text-faint" />
        <p className="text-sm text-muted">No runs in the last {data.days} days. Usage appears here as soon as you ask something in Chat or Code.</p>
      </div>
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Tokens" value={fmtCount(tokens)} detail={`${fmtCount(t.promptTokens)} in · ${fmtCount(t.completionTokens)} out`} testId="usage-total-tokens" />
        <Stat label="Estimated cost" value={fmtUsd(t.costUsd)} detail="from provider prices" />
        <Stat label="Runs" value={fmtCount(t.runs)} detail={`${t.completedRuns} completed · ${t.failedRuns} failed${t.cancelledRuns ? ` · ${t.cancelledRuns} stopped` : ''}`} testId="usage-total-runs" />
        <Stat label="Model calls" value={fmtCount(t.modelCalls)} detail={`${t.failedModelCalls} failed · ${t.fallbacks} fallbacks`} />
        <Stat label="Average latency" value={t.avgLatencyMs === null ? '—' : formatDuration(t.avgLatencyMs)} detail="per model call" />
      </div>

      <DailyChart data={data} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Card title="By source" icon={Plug}>
          <SourceBars data={data} />
        </Card>
        <Card title="By model" icon={BarChart3}>
          <ModelTable data={data} />
        </Card>
      </div>

      {data.byCodeWorkspace.length > 0 && (
        <Card title="By repository" icon={Code2}>
          <RepositoryTable data={data} />
        </Card>
      )}
    </>
  );
}

function Stat({ label, value, detail, testId }: { label: string; value: string; detail: string; testId?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface/50 p-4" data-testid={testId}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-1 truncate text-[11px] text-faint" title={detail}>
        {detail}
      </p>
    </div>
  );
}

/** Clean axis maximum: 1, 2 or 5 × a power of ten, at or above the largest value. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

const METRICS: Record<Metric, { label: string; get: (d: UsageHistory['daily'][number]) => number; format: (v: number) => string; tick: (v: number) => string }> = {
  tokens: { label: 'Tokens', get: (d) => d.promptTokens + d.completionTokens, format: (v) => whole.format(v), tick: (v) => compact.format(v) },
  cost: { label: 'Cost', get: (d) => d.costUsd, format: fmtUsd, tick: (v) => (v === 0 ? '$0' : `$${v < 0.01 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : compact.format(v)}`) },
  runs: { label: 'Runs', get: (d) => d.runs, format: (v) => whole.format(v), tick: (v) => compact.format(v) },
};

/**
 * Daily columns, one series (so no legend: the title names it). Each day's full-height column is
 * its hit target; arrow keys move the readout for keyboard users, and a table view carries every
 * value without hovering.
 */
function DailyChart({ data }: { data: UsageHistory }) {
  const [metric, setMetric] = useState<Metric>('tokens');
  const [asTable, setAsTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const m = METRICS[metric];
  const values = useMemo(() => data.daily.map(m.get), [data.daily, m]);
  const max = niceMax(Math.max(...values));
  const ticks = [max, max / 2, 0];
  const n = data.daily.length;
  const labelAt = new Set([0, Math.floor((n - 1) / 2), n - 1]);
  const focusDay = active ?? null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setActive((i) => {
      const cur = i ?? n - 1;
      if (e.key === 'Home') return 0;
      if (e.key === 'End') return n - 1;
      return Math.min(n - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
    });
  };

  return (
    <Card
      title={`${m.label} per day`}
      icon={BarChart3}
      action={
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-full bg-surface/60 p-0.5" role="radiogroup" aria-label="Metric">
            {(Object.keys(METRICS) as Metric[]).map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={metric === k}
                onClick={() => setMetric(k)}
                className={cn('h-6 rounded-full px-2.5 text-[11px] font-medium transition', metric === k ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:text-ink')}
                data-testid={`usage-metric-${k}`}
              >
                {METRICS[k].label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable} data-testid="usage-table-toggle">
            <Table2 className="size-3.5" /> {asTable ? 'Chart' : 'Table'}
          </Button>
        </div>
      }
    >
      {asTable ? (
        <div className="max-h-72 overflow-y-auto rounded-xl border border-line">
          <table className="w-full text-left text-xs" data-testid="usage-daily-table">
            <thead className="sticky top-0 bg-surface text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Day (UTC)</th>
                <th className="px-3 py-2 text-right font-medium">Runs</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {[...data.daily].reverse().map((d) => (
                <tr key={d.date} className="border-t border-line/70">
                  <td className="px-3 py-1.5 text-ink-soft">{fmtDay(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td className="px-3 py-1.5 text-right text-ink">{whole.format(d.runs)}</td>
                  <td className="px-3 py-1.5 text-right text-ink">{whole.format(d.promptTokens + d.completionTokens)}</td>
                  <td className="px-3 py-1.5 text-right text-ink">{fmtUsd(d.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex gap-3">
          {/* Y axis: three clean ticks. */}
          <div className="relative w-12 shrink-0 text-right text-[10px] tabular-nums text-faint" style={{ height: 180 }} aria-hidden>
            {ticks.map((v) => (
              <span key={v} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - v / max) * 100}%` }}>
                {m.tick(v)}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              style={{ height: 180 }}
              tabIndex={0}
              role="img"
              aria-label={`${m.label} per day over the last ${data.days} days. Use the arrow keys to read each day, or switch to the table.`}
              onKeyDown={onKey}
              onBlur={() => setActive(null)}
              onPointerLeave={() => setActive(null)}
              data-testid="usage-chart"
            >
              {/* Hairline gridlines, solid and recessive. */}
              {ticks.map((v) => (
                <div key={v} className="pointer-events-none absolute inset-x-0 border-t border-line" style={{ top: `${(1 - v / max) * 100}%` }} />
              ))}
              <div className="absolute inset-0 flex items-end" style={{ gap: 2 }}>
                {data.daily.map((d, i) => {
                  const v = values[i]!;
                  const h = (v / max) * 100;
                  return (
                    <div key={d.date} className="flex h-full min-w-0 flex-1 items-end justify-center" onPointerEnter={() => setActive(i)} data-testid="usage-day">
                      <div
                        className={cn('w-full max-w-6 rounded-t-[4px] bg-accent transition-opacity', focusDay !== null && focusDay !== i && 'opacity-45')}
                        style={{ height: v > 0 ? `max(${h}%, 2px)` : 0 }}
                      />
                    </div>
                  );
                })}
              </div>
              {focusDay !== null && (
                <Tooltip
                  left={((focusDay + 0.5) / n) * 100}
                  value={m.format(values[focusDay]!)}
                  label={fmtDay(data.daily[focusDay]!.date, { weekday: 'short', month: 'short', day: 'numeric' })}
                  detail={`${whole.format(data.daily[focusDay]!.runs)} runs`}
                />
              )}
            </div>
            <div className="relative mt-2 h-4 text-[10px] text-faint" aria-hidden>
              {data.daily.map((d, i) =>
                labelAt.has(i) ? (
                  <span
                    key={d.date}
                    className={cn('absolute', i === 0 ? 'left-0' : i === n - 1 ? 'right-0' : '-translate-x-1/2')}
                    style={i !== 0 && i !== n - 1 ? { left: `${((i + 0.5) / n) * 100}%` } : undefined}
                  >
                    {fmtDay(d.date)}
                  </span>
                ) : null,
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function Tooltip({ left, value, label, detail }: { left: number; value: string; label: string; detail: string }) {
  const align = left < 15 ? 'translate-x-0' : left > 85 ? '-translate-x-full' : '-translate-x-1/2';
  return (
    <div
      className={cn('pointer-events-none absolute top-0 z-10 rounded-xl border border-line bg-surface px-3 py-2 shadow-float', align)}
      style={{ left: `${left}%` }}
      role="status"
      data-testid="usage-tooltip"
    >
      <div className="text-sm font-semibold tabular-nums text-ink">{value}</div>
      <div className="whitespace-nowrap text-[11px] text-muted">
        {label} · {detail}
      </div>
    </div>
  );
}

/** Share of tokens per source: one hue for magnitude; identity comes from the text label. */
function SourceBars({ data }: { data: UsageHistory }) {
  const rows = data.bySource.map((s) => ({ ...s, tokens: s.promptTokens + s.completionTokens }));
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  return (
    <ul className="space-y-4" data-testid="usage-sources">
      {rows.map((s) => {
        const { label, icon: Icon } = SOURCES[s.source];
        return (
          <li key={s.source}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="flex items-center gap-1.5 font-medium text-ink-soft">
                <Icon className="size-3.5 text-muted" /> {label}
              </span>
              <span className="tabular-nums text-ink">
                {fmtCount(s.tokens)} tokens <span className="text-muted">· {whole.format(s.runs)} runs · {fmtUsd(s.costUsd)}</span>
              </span>
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-violet-soft">
              <div className="h-full rounded-full bg-accent" style={{ width: s.tokens ? `max(${(s.tokens / max) * 100}%, 4px)` : 0 }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ModelTable({ data }: { data: UsageHistory }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-xs" data-testid="usage-models">
        <thead className="text-muted">
          <tr>
            <th className="pb-2 font-medium">Model</th>
            <th className="pb-2 text-right font-medium">Calls</th>
            <th className="pb-2 text-right font-medium">Tokens</th>
            <th className="pb-2 text-right font-medium">Cost</th>
            <th className="pb-2 text-right font-medium">Avg</th>
            <th className="pb-2 text-right font-medium">p95</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {data.byModel.map((m) => (
            <tr key={`${m.provider}/${m.model}`} className="border-t border-line/70">
              <td className="py-2 pr-3">
                <div className="font-mono text-[11.5px] text-ink">{m.model.startsWith(`${m.provider}/`) ? m.model.slice(m.provider.length + 1) : m.model}</div>
                <div className="text-[10.5px] text-faint">
                  {m.provider}
                  {m.failedCalls > 0 && ` · ${m.failedCalls} failed`}
                </div>
              </td>
              <td className="py-2 text-right text-ink">{whole.format(m.calls)}</td>
              <td className="py-2 text-right text-ink">{fmtCount(m.promptTokens + m.completionTokens)}</td>
              <td className="py-2 text-right text-ink">{fmtUsd(m.costUsd)}</td>
              <td className="py-2 text-right text-ink-soft">{formatDuration(m.avgLatencyMs)}</td>
              <td className="py-2 text-right text-ink-soft">{formatDuration(m.p95LatencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RepositoryTable({ data }: { data: UsageHistory }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-xs" data-testid="usage-repositories">
        <thead className="text-muted">
          <tr>
            <th className="pb-2 font-medium">Repository</th>
            <th className="pb-2 text-right font-medium">Runs</th>
            <th className="pb-2 text-right font-medium">Tests</th>
            <th className="pb-2 text-right font-medium">Tokens</th>
            <th className="pb-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {data.byCodeWorkspace.map((w) => (
            <tr key={w.codeWorkspaceId} className="border-t border-line/70">
              <td className="py-2 pr-3">
                <button className="font-mono text-[11.5px] text-ink hover:text-accent" onClick={() => navigateTo(`/code/${w.codeWorkspaceId}/tasks`)}>
                  {w.repository}
                </button>
              </td>
              <td className="py-2 text-right text-ink">{whole.format(w.runs)}</td>
              <td className="py-2 text-right text-ink-soft">
                {w.testsPassed + w.testsFailed === 0 ? '—' : `${w.testsPassed} passed · ${w.testsFailed} failed`}
              </td>
              <td className="py-2 text-right text-ink">{fmtCount(w.promptTokens + w.completionTokens)}</td>
              <td className="py-2 text-right text-ink">{fmtUsd(w.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
