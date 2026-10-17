import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FlaskConical, GitBranch, History, ListChecks, Play, Search } from 'lucide-react';
import { codeApi, type CodeRunSummary } from '@/lib/code-api';
import { cn, formatCost, formatDuration, relativeTime } from '@/lib/utils';
import { codeKeys } from '@/hooks/code';
import { navigateTo } from '@/hooks/route';
import { useCode } from '@/stores/code';
import { Button } from '@/components/ui/button';
import { DiffStat } from './DiffView';
import { inputClass, Segmented, StatusDot } from './shared';
import { WorkspacePage } from './WorkspacePage';

type Filter = 'all' | 'running' | 'completed' | 'failed' | 'cancelled';

/** The task as the user wrote it (structured "Target:" suffixes from context actions removed). */
const taskTitle = (r: CodeRunSummary) => (r.instruction ?? 'Untitled task').split('\n\nTarget: ')[0]!.trim();

/** Tasks: every Code Agent run in this workspace with its outcome, artifacts and replay. */
export function TasksPage({ workspaceId }: { workspaceId: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const runs = useQuery({
    queryKey: [...codeKeys.runs(workspaceId), 'tasks', filter],
    queryFn: () => codeApi.runs(workspaceId, { limit: 200, ...(filter !== 'all' && filter !== 'running' ? { status: filter } : {}) }),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running' || r.status === 'queued') ? 4000 : false),
  });
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (runs.data ?? [])
      .filter((r) => (filter === 'running' ? r.status === 'running' || r.status === 'queued' : true))
      .filter((r) => !q || taskTitle(r).toLowerCase().includes(q) || (r.agentBranch ?? '').toLowerCase().includes(q));
  }, [runs.data, filter, query]);
  const counts = useMemo(() => {
    const all = runs.data ?? [];
    return { running: all.filter((r) => r.status === 'running' || r.status === 'queued').length };
  }, [runs.data]);

  const open = (r: CodeRunSummary) => {
    useCode.getState().setActiveRun(workspaceId, r.runId);
    useCode.getState().setAgentTab('chat');
    navigateTo(`/code/${workspaceId}`);
  };

  return (
    <WorkspacePage workspaceId={workspaceId} title="Tasks">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Tasks</h1>
          <p className="mt-1 text-sm text-muted">Every Code Agent run in this workspace: what was asked, what changed, whether tests passed, and what shipped.</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => navigateTo(`/code/${workspaceId}`)}>
          <Play className="size-3.5" /> New task
        </Button>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'all', label: 'All', testId: 'tasks-filter-all' },
            { id: 'running', label: 'Running', badge: counts.running || undefined },
            { id: 'completed', label: 'Completed' },
            { id: 'failed', label: 'Failed', testId: 'tasks-filter-failed' },
            { id: 'cancelled', label: 'Stopped' },
          ]}
        />
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input className={cn(inputClass, 'py-1.5 pl-8 text-xs')} placeholder="Search tasks or branches" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="tasks-search" />
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface/50" data-testid="tasks-list">
        {runs.isLoading && <div className="px-4 py-8 text-center text-xs text-faint">Loading tasks…</div>}
        {runs.data && list.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <History className="size-7 text-faint" />
            <p className="text-sm text-muted">{query || filter !== 'all' ? 'No tasks match.' : 'No tasks yet. Ask the Code Agent for a change in the editor.'}</p>
          </div>
        )}
        {list.map((r) => {
          const duration = r.startedAt && r.completedAt ? Date.parse(r.completedAt) - Date.parse(r.startedAt) : null;
          return (
            <div key={r.runId} className="flex flex-col gap-2 border-b border-line/70 px-4 py-3 last:border-0 sm:flex-row sm:items-center" data-testid="task-row">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <StatusDot status={r.status} className="mt-1.5" />
                <div className="min-w-0">
                  <button className="line-clamp-2 text-left text-sm font-medium text-ink hover:text-accent" onClick={() => open(r)} title={taskTitle(r)}>
                    {taskTitle(r)}
                  </button>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                    <span className="capitalize">{r.status === 'cancelled' ? 'stopped' : r.status}</span>
                    <span>{relativeTime(r.createdAt)}</span>
                    {duration !== null && <span>{formatDuration(duration)}</span>}
                    <span className="capitalize">{r.approvalMode}</span>
                    {r.planApproved && (
                      <span className="inline-flex items-center gap-1 text-accent">
                        <ListChecks className="size-3" /> plan reviewed
                      </span>
                    )}
                    {r.filesChanged > 0 && <DiffStat files={[{ additions: r.additions, deletions: r.deletions }]} />}
                    {r.testsPassed !== null && (
                      <span className={cn('inline-flex items-center gap-1', r.testsPassed ? 'text-emerald-600' : 'text-rose-500')}>
                        <FlaskConical className="size-3" /> {r.testsPassed ? 'tests passed' : 'tests failed'}
                      </span>
                    )}
                    {r.agentBranch && (
                      <span className="inline-flex max-w-56 items-center gap-1 font-mono">
                        <GitBranch className="size-3 shrink-0" /> <span className="truncate">{r.agentBranch}</span>
                      </span>
                    )}
                    {r.tokens > 0 && <span>{r.tokens.toLocaleString('en-US')} tokens</span>}
                    {r.costUsd !== null && r.costUsd > 0 && <span>{formatCost(r.costUsd)}</span>}
                  </div>
                  {r.error && r.status === 'failed' && <p className="mt-1 line-clamp-1 text-[11px] text-rose-500">{r.error}</p>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 pl-5 sm:pl-0">
                {r.pullRequest && (
                  <Button variant="outline" size="sm" className="h-7" asChild>
                    <a href={r.pullRequest.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3" /> PR #{r.pullRequest.number}
                    </a>
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="h-7" onClick={() => navigateTo(`/code/${workspaceId}/replay/${r.runId}`)} data-testid="task-replay">
                  <History className="size-3" /> Replay
                </Button>
                <Button variant="outline" size="sm" className="h-7" onClick={() => open(r)} data-testid="task-open">
                  Open
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </WorkspacePage>
  );
}
