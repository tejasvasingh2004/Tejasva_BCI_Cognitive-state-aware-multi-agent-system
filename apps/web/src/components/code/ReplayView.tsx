import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Database, DatabaseZap, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { codeApi, labApi } from '@/lib/code-api';
import { reduceCodeEvents } from '@/lib/code-run-view';
import { cn, formatDuration, formatTime } from '@/lib/utils';
import { navigateTo, useDocumentTitle } from '@/hooks/route';
import { useToasts } from '@/stores/toasts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Sparkle } from '@/components/ui/sparkle';
import { Markdown } from '@/components/workspace/Markdown';
import { DiffStat, DiffView } from './DiffView';
import { errorMessage, StatusDot } from './shared';

/**
 * Code run replay. Reads the persisted events and artifacts (patches, executions, approvals, Git
 * operations) — it never re-runs the task, calls a model or touches the repository.
 */
export function ReplayView({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  useDocumentTitle('Replay · NeuroFlow Code');
  const replay = useQuery({ queryKey: ['code-replay', runId], queryFn: () => codeApi.replay(runId), staleTime: Infinity });
  const evaluation = useQuery({ queryKey: ['code-evaluation', runId], queryFn: () => codeApi.evaluation(runId), staleTime: 60_000 });
  const events = useMemo(() => replay.data?.events ?? [], [replay.data]);
  const [position, setPosition] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const pos = position ?? events.length;
  const view = useMemo(() => reduceCodeEvents(events.slice(0, pos)), [events, pos]);

  useEffect(() => {
    if (!playing) return;
    if (pos >= events.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setPosition(pos + 1), 350);
    return () => clearTimeout(t);
  }, [playing, pos, events.length]);

  if (replay.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Sparkle className="size-7" animated />
      </div>
    );
  }
  if (replay.error || !replay.data) {
    return <div className="flex h-full items-center justify-center text-sm text-rose-500">{errorMessage(replay.error, 'Replay not found')}</div>;
  }
  const r = replay.data;
  const current = events[pos - 1];
  const duration = r.run.startedAt && r.run.completedAt ? Date.parse(r.run.completedAt) - Date.parse(r.run.startedAt) : null;

  return (
    <div className="flex h-full flex-col gap-2 p-2" data-testid="replay-view">
      <header className="glass flex h-12 shrink-0 items-center gap-3 rounded-[20px] px-3">
        <Button variant="ghost" size="sm" onClick={() => navigateTo(`/code/${workspaceId}`)}>
          <ArrowLeft className="size-3.5" /> Workspace
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">Replay · {r.instruction?.split('\n')[0] ?? 'Code run'}</div>
        <SaveToDataset runId={runId} />
        <span className="hidden items-center gap-1.5 rounded-full bg-mint-soft px-2.5 py-1 text-[11px] text-emerald-700 md:flex">
          <Database className="size-3" /> Recorded history — nothing is re-executed
        </span>
      </header>
      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <section className="glass flex min-h-0 flex-col overflow-hidden rounded-[20px]">
          <div className="border-b border-line/70 p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <StatusDot status={r.run.status} /> <span className="capitalize text-ink">{r.run.status}</span>
              </span>
              <span>{formatTime(r.run.createdAt)}</span>
              {duration !== null && <span>{formatDuration(duration)}</span>}
              {r.codeRun && <span className="capitalize">{r.codeRun.approvalMode} mode</span>}
              {r.codeRun?.agentBranch && <span className="font-mono">{r.codeRun.agentBranch}</span>}
              {r.codeRun?.finalCommit && <span className="font-mono">{r.codeRun.finalCommit.slice(0, 7)}</span>}
              {evaluation.data && (
                <span className="rounded-full bg-violet-soft px-2 text-accent" title="Coding evaluation score from recorded signals">
                  score {Math.round(evaluation.data.score * 100)}%
                </span>
              )}
            </div>
            {r.instruction && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5 text-ink">{r.instruction}</p>}
          </div>
          <div className="flex items-center gap-1.5 border-b border-line/70 px-3 py-2">
            <Button variant="ghost" size="icon-sm" onClick={() => setPosition(0)} aria-label="To start">
              <SkipBack className="size-3.5" />
            </Button>
            <Button
              variant="primary"
              size="icon-sm"
              onClick={() => {
                if (pos >= events.length) setPosition(0);
                setPlaying((p) => !p);
              }}
              aria-label={playing ? 'Pause' : 'Play'}
              data-testid="replay-play"
            >
              {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setPosition(events.length)} aria-label="To end">
              <SkipForward className="size-3.5" />
            </Button>
            <input type="range" min={0} max={events.length} value={pos} onChange={(e) => setPosition(Number(e.target.value))} className="flex-1 accent-violet-500" aria-label="Replay position" />
            <span className="w-24 shrink-0 text-right font-mono text-[10.5px] text-faint">
              {pos}/{events.length} {current ? formatTime(current.ts) : ''}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {view.plan && (
              <div className="mb-3 rounded-xl bg-surface/60 px-3 py-2">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">Plan</div>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-ink-soft">
                  {view.plan.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </div>
            )}
            <div className="flex flex-col gap-1.5" data-testid="replay-activity">
              {view.activity.map((a, i) => (
                <div key={a.key} className={cn('flex items-start gap-2 text-xs', i === view.activity.length - 1 && position !== null ? 'text-ink' : 'text-ink-soft')}>
                  <StatusDot status={a.status === 'done' ? 'passed' : a.status === 'failed' ? 'failed' : 'running'} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{a.title}</div>
                    {a.detail && <div className="truncate text-[11px] text-faint">{a.detail}</div>}
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-faint">{formatTime(a.ts)}</span>
                </div>
              ))}
            </div>
            {pos === events.length && r.output && (
              <div className="prose-nf mt-4 border-t border-line pt-3 text-[13px]">
                <Markdown text={r.output} />
              </div>
            )}
          </div>
        </section>
        <section className="glass min-h-0 overflow-y-auto rounded-[20px] p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">Patches ({r.patches.length})</h3>
          <div className="mt-2 flex flex-col gap-3">
            {r.patches.length === 0 && <div className="text-xs text-faint">No patches were proposed.</div>}
            {[...r.patches].reverse().map((p) => (
              <div key={p.id}>
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium capitalize', p.status === 'applied' ? 'bg-mint-soft text-emerald-700' : p.status === 'rejected' ? 'bg-rose-soft text-rose-600' : 'bg-surface text-muted')}>
                    {p.status.replace('_', ' ')}
                  </span>
                  <DiffStat files={p.files} />
                  <span className="ml-auto font-mono text-[10px] text-faint">{formatTime(p.createdAt)}</span>
                </div>
                <DiffView diff={p.diff} maxLines={600} />
              </div>
            ))}
          </div>
          <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-faint">Commands ({r.executions.length})</h3>
          <div className="mt-2 flex flex-col gap-2">
            {[...r.executions].reverse().map((e) => (
              <details key={e.id} className="rounded-xl border border-line bg-surface/60">
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs">
                  <StatusDot status={e.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{e.command}</span>
                  <span className="text-[10.5px] text-faint">
                    {e.kind} · exit {e.exitCode ?? '—'} · {formatDuration(e.durationMs)}
                  </span>
                </summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 font-mono text-[11px] text-ink-soft">{e.output || '(no output)'}</pre>
              </details>
            ))}
          </div>
          {(r.approvals.length > 0 || r.operations.length > 0) && (
            <>
              <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-faint">Approvals & Git</h3>
              <div className="mt-2 flex flex-col gap-1 text-xs text-ink-soft">
                {r.approvals.map((a, i) => (
                  <div key={`a${i}`} className="flex gap-2">
                    <span className={cn('w-16 shrink-0 capitalize', a.decision === 'approved' ? 'text-emerald-600' : a.decision === 'rejected' ? 'text-rose-500' : 'text-muted')}>{a.decision}</span>
                    <span className="min-w-0 flex-1 truncate">{a.subjectType.replace('_', ' ')}</span>
                    <span className="font-mono text-[10px] text-faint">{formatTime(a.createdAt)}</span>
                  </div>
                ))}
                {r.operations.map((o) => (
                  <div key={o.id} className="flex gap-2">
                    <span className="w-16 shrink-0 text-accent">{o.kind.replace('_', ' ')}</span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {o.url ? (
                        <a className="underline" href={o.url} target="_blank" rel="noreferrer">
                          {o.message ?? o.url}
                        </a>
                      ) : (
                        `${o.ref ?? ''} ${o.sha?.slice(0, 7) ?? ''} ${o.message ?? ''}`
                      )}
                    </span>
                    <span className="font-mono text-[10px] text-faint">{formatTime(o.createdAt)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {evaluation.data && (
            <>
              <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-faint">Evaluation signals</h3>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {Object.entries(evaluation.data.signals).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <span className="text-muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                    <span className="font-mono text-ink-soft">{v === null ? '—' : k === 'executionDurationMs' ? formatDuration(v as number) : String(v)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** Explicit user action: keep this recorded run as a candidate dataset example (reviewed later). */
function SaveToDataset({ runId }: { runId: string }) {
  const { data: datasets = [] } = useQuery({ queryKey: ['lab-datasets'], queryFn: labApi.datasets });
  const pushToast = useToasts((s) => s.push);
  const save = useMutation({
    mutationFn: (v: { datasetId: string; outcome: 'accepted' | 'rejected' | 'neutral' }) => labApi.exampleFromRun(v.datasetId, runId, v.outcome),
    onSuccess: () => pushToast({ tone: 'success', title: 'Saved to dataset', body: 'Review it in Model Lab before it can be exported' }),
    onError: (err) => pushToast({ tone: 'error', title: 'Could not save', body: errorMessage(err) }),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="save-to-dataset">
          <DatabaseZap className="size-3.5" /> Save to dataset
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {datasets.length === 0 ? (
          <DropdownMenuItem onSelect={() => navigateTo('/lab/datasets')}>Create a dataset in Model Lab…</DropdownMenuItem>
        ) : (
          datasets.map((d) => (
            <div key={d.id}>
              <DropdownMenuLabel>{d.name}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => save.mutate({ datasetId: d.id, outcome: 'accepted' })}>Good outcome</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => save.mutate({ datasetId: d.id, outcome: 'rejected' })}>Bad outcome</DropdownMenuItem>
              <DropdownMenuSeparator />
            </div>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
