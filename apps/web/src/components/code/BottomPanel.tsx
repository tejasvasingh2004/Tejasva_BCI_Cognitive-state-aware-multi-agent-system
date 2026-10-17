import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, ChevronDown, FlaskConical, Info, Play, Trash2 } from 'lucide-react';
import type { CodeWorkspace, SandboxExecution } from '@neuroflow/contracts';
import { codeApi } from '@/lib/code-api';
import { cn, formatDuration, formatTime } from '@/lib/utils';
import { useCodeRunView, useDiff, useExecutions } from '@/hooks/code';
import { useCode, type BottomTab } from '@/stores/code';
import { Button } from '@/components/ui/button';
import { DiffStat, DiffView } from './DiffView';
import { GitActions } from './GitActions';
import { errorMessage, Segmented, StatusDot } from './shared';

export function BottomPanel({ workspace, commands, sandboxAvailable }: { workspace: CodeWorkspace; commands: Record<string, string>; sandboxAvailable: boolean }) {
  const tab = useCode((s) => s.bottomTab);
  const setTab = useCode((s) => s.setBottomTab);
  const setOpen = useCode((s) => s.setBottomOpen);
  const markers = useCode((s) => s.markers);
  const runId = useCode((s) => s.activeRun[workspace.id] ?? null);
  const diff = useDiff(workspace.id, workspace.status);
  const errors = markers.filter((m) => m.severity === 'error').length;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bottom-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line/70 px-2">
        <Segmented<BottomTab>
          size="xs"
          value={tab}
          onChange={(t) => setTab(t)}
          options={[
            { id: 'terminal', label: 'Terminal', testId: 'bottom-terminal' },
            { id: 'problems', label: 'Problems', badge: errors || undefined, testId: 'bottom-problems' },
            { id: 'tests', label: 'Tests', testId: 'bottom-tests' },
            { id: 'diff', label: 'Git Diff', badge: diff.data?.files.length || undefined, testId: 'bottom-diff' },
            { id: 'logs', label: 'Agent Logs', testId: 'bottom-logs' },
          ]}
        />
        <button className="ml-auto rounded p-1 text-faint hover:text-ink" onClick={() => setOpen(false)} aria-label="Hide panel">
          <ChevronDown className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'terminal' && <TerminalTab workspace={workspace} commands={commands} sandboxAvailable={sandboxAvailable} />}
        {tab === 'problems' && <ProblemsTab />}
        {tab === 'tests' && <TestsTab workspace={workspace} commands={commands} sandboxAvailable={sandboxAvailable} />}
        {tab === 'diff' && <DiffTab workspace={workspace} runId={runId} />}
        {tab === 'logs' && <LogsTab workspace={workspace} runId={runId} />}
      </div>
    </div>
  );
}

function OutputBlock({ text, className }: { text: string; className?: string }) {
  return <pre className={cn('whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[17px] text-ink-soft', className)}>{text}</pre>;
}

function TerminalTab({ workspace, commands, sandboxAvailable }: { workspace: CodeWorkspace; commands: Record<string, string>; sandboxAvailable: boolean }) {
  const entries = useCode((s) => s.terminal);
  const upsert = useCode((s) => s.upsertTerminal);
  const clear = useCode((s) => s.clearTerminal);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [entries]);
  const run = useMutation({
    mutationFn: (v: { command: string; kind: 'command' | 'test' | 'lint' | 'build' | 'install' }) => codeApi.runCommand(workspace.id, v.command, v.kind),
    onSuccess: (r, v) => upsert(r.correlationId, { command: v.command, kind: v.kind, network: r.network, status: 'queued' }),
    onError: (err, v) => upsert(crypto.randomUUID(), { command: v.command, status: 'denied', message: errorMessage(err) }),
  });
  const submit = (command: string, kind: 'command' | 'test' | 'lint' | 'build' | 'install' = 'command') => {
    if (!command.trim()) return;
    setHistory((h) => [command, ...h.filter((x) => x !== command)].slice(0, 50));
    setHIndex(-1);
    run.mutate({ command: command.trim(), kind });
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line/50 px-3 py-1">
        {(['install', 'test', 'lint', 'build'] as const).map((k) =>
          commands[k] ? (
            <Button key={k} variant="ghost" size="sm" className="h-6 px-2 text-[11px]" disabled={!sandboxAvailable} onClick={() => submit(commands[k]!, k)} title={commands[k]}>
              <Play className="size-3" /> {k}
            </Button>
          ) : null,
        )}
        <span className="ml-auto text-[10.5px] text-faint">
          {sandboxAvailable ? 'Isolated sandbox · no network except installs · no secrets' : 'Sandbox unavailable — commands cannot run'}
        </span>
        <button className="rounded p-1 text-faint hover:text-ink" onClick={clear} aria-label="Clear terminal">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas/40 px-3 py-2" data-testid="terminal-output">
        {entries.length === 0 && <div className="text-[11.5px] text-faint">Commands run in a container with the repository mounted. Output streams here.</div>}
        {entries.map((e) => (
          <div key={e.id} className="mb-2">
            <div className="flex items-center gap-2 font-mono text-[11.5px]">
              <span className="text-accent">$</span>
              <span className="text-ink">{e.command}</span>
              <StatusDot status={e.status} className="ml-1" />
              <span className="text-[10.5px] text-faint">
                {e.status === 'queued'
                  ? 'queued'
                  : e.status === 'running'
                    ? 'running'
                    : e.status === 'denied'
                      ? 'not allowed'
                      : `exit ${e.exitCode ?? '?'}${e.durationMs !== undefined ? ` · ${formatDuration(e.durationMs)}` : ''}`}
                {e.network ? ' · network' : ''}
              </span>
            </div>
            {e.output && <OutputBlock text={e.output} className="mt-0.5" />}
            {e.message && <div className="mt-0.5 text-[11px] text-rose-500">{e.message}</div>}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-line/50 px-3 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
          setInput('');
        }}
      >
        <span className="font-mono text-xs text-accent">$</span>
        <input
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-faint"
          placeholder={sandboxAvailable ? 'Run a command in the sandbox' : 'Sandbox unavailable'}
          disabled={!sandboxAvailable}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = Math.min(hIndex + 1, history.length - 1);
              setHIndex(i);
              setInput(history[i]!);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const i = hIndex - 1;
              setHIndex(Math.max(-1, i));
              setInput(i >= 0 ? history[i]! : '');
            }
          }}
          data-testid="terminal-input"
        />
      </form>
    </div>
  );
}

function ProblemsTab() {
  const markers = useCode((s) => s.markers);
  const revealLine = useCode((s) => s.revealLine);
  const sorted = useMemo(() => [...markers].sort((a, b) => (a.severity === b.severity ? a.path.localeCompare(b.path) || a.line - b.line : a.severity === 'error' ? -1 : 1)), [markers]);
  if (!sorted.length) return <div className="px-4 py-3 text-xs text-faint">No problems detected in open files.</div>;
  return (
    <div className="h-full overflow-y-auto py-1">
      {sorted.map((m, i) => (
        <button key={i} onClick={() => revealLine(m.path, m.line)} className="flex w-full items-start gap-2 px-3 py-0.5 text-left text-xs hover:bg-surface/60">
          {m.severity === 'error' ? (
            <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
          ) : m.severity === 'warning' ? (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          ) : (
            <Info className="mt-0.5 size-3.5 shrink-0 text-sky-500" />
          )}
          <span className="min-w-0 flex-1 text-ink-soft">{m.message}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-faint">
            {m.path}:{m.line}:{m.column}
          </span>
        </button>
      ))}
    </div>
  );
}

function ExecutionRow({ e, open, onToggle }: { e: SandboxExecution; open: boolean; onToggle(): void }) {
  return (
    <div className="border-b border-line/50">
      <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface/60" onClick={onToggle}>
        <StatusDot status={e.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{e.command}</span>
        <span className="shrink-0 text-[10.5px] text-faint">
          {e.triggeredBy === 'agent' ? 'agent' : 'you'} · {e.status}
          {e.durationMs != null ? ` · ${formatDuration(e.durationMs)}` : ''} · {formatTime(e.createdAt)}
        </span>
      </button>
      {open && <OutputBlock text={e.output || '(no output)'} className="max-h-72 overflow-y-auto bg-canvas/40 px-3 py-2" />}
    </div>
  );
}

function TestsTab({ workspace, commands, sandboxAvailable }: { workspace: CodeWorkspace; commands: Record<string, string>; sandboxAvailable: boolean }) {
  const { data: executions = [] } = useExecutions(workspace.id);
  const tests = executions.filter((e) => e.kind === 'test');
  const [open, setOpen] = useState<string | null>(null);
  const upsert = useCode((s) => s.upsertTerminal);
  const setTab = useCode((s) => s.setBottomTab);
  const run = useMutation({
    mutationFn: () => codeApi.runCommand(workspace.id, commands.test!, 'test'),
    onSuccess: (r) => {
      upsert(r.correlationId, { command: commands.test!, kind: 'test', status: 'queued' });
      setTab('terminal');
    },
  });
  const last = tests[0];
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line/50 px-3 py-1.5 text-xs">
        <FlaskConical className="size-3.5 text-faint" />
        {last ? (
          <span className={cn(last.status === 'passed' ? 'text-emerald-600' : 'text-rose-500')}>
            Last run {last.status} {formatTime(last.createdAt)}
          </span>
        ) : (
          <span className="text-faint">No test runs yet</span>
        )}
        <Button variant="outline" size="sm" className="ml-auto h-6 px-2 text-[11px]" disabled={!commands.test || !sandboxAvailable || run.isPending} onClick={() => run.mutate()} title={commands.test}>
          <Play className="size-3" /> Run tests
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tests.map((e) => (
          <ExecutionRow key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
        ))}
        {!commands.test && <div className="px-3 py-3 text-xs text-faint">No test command detected for this project.</div>}
      </div>
    </div>
  );
}

function DiffTab({ workspace, runId }: { workspace: CodeWorkspace; runId: string | null }) {
  const diff = useDiff(workspace.id, workspace.status);
  const openFile = useCode((s) => s.openFile);
  const { view } = useCodeRunView(workspace.id, runId);
  const runDone = view?.status === 'completed';
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto p-2" data-testid="git-diff">
        {diff.data && diff.data.files.length > 0 && (
          <div className="mb-2 px-1">
            <DiffStat files={diff.data.files} />
          </div>
        )}
        <DiffView diff={diff.data?.diff ?? ''} onOpenFile={(p) => openFile(p, 'diff')} emptyText="Working tree clean" />
      </div>
      <div className="w-64 shrink-0 overflow-y-auto border-l border-line/60 p-3">
        <GitActions workspace={workspace} runId={runDone ? runId : null} compact />
      </div>
    </div>
  );
}

function LogsTab({ workspace, runId }: { workspace: CodeWorkspace; runId: string | null }) {
  const { view, code } = useCodeRunView(workspace.id, runId);
  const [open, setOpen] = useState<string | null>(null);
  if (!runId || !view) return <div className="px-4 py-3 text-xs text-faint">Agent execution logs (models, tools, commands) appear here while the agent works.</div>;
  return (
    <div className="h-full overflow-y-auto px-3 py-2 font-mono text-[11px] leading-[18px]" data-testid="agent-logs">
      {view.plan && (
        <div className="text-faint">
          strategy={view.plan.agentStrategy} models={view.plan.models.map((m) => m.model).join(',')} reasoning={view.plan.reasoningBudget}
        </div>
      )}
      {view.steps.map((s) => (
        <div key={s.key} className="flex gap-2">
          <span className="w-16 shrink-0 text-faint">{new Date(s.startedAt).toLocaleTimeString([], { hour12: false })}</span>
          <span className={cn('w-14 shrink-0', s.status === 'failed' ? 'text-rose-500' : s.status === 'active' ? 'text-accent' : 'text-emerald-600')}>{s.status}</span>
          <span className="w-16 shrink-0 text-muted">{s.kind}</span>
          <span className="min-w-0 flex-1 truncate text-ink-soft">
            {s.label}
            {s.detail ? ` — ${s.detail}` : ''}
          </span>
          {s.endedAt && <span className="shrink-0 text-faint">{formatDuration(s.endedAt - s.startedAt)}</span>}
        </div>
      ))}
      {code?.commands.map((c) => (
        <div key={c.executionId} className="mt-1">
          <button className="flex w-full gap-2 text-left hover:bg-surface/50" onClick={() => setOpen(open === c.executionId ? null : c.executionId)}>
            <span className="text-accent">$</span>
            <span className="min-w-0 flex-1 truncate text-ink">{c.command}</span>
            <span className="text-faint">
              {c.status}
              {c.exitCode !== undefined ? ` (${c.exitCode})` : ''}
            </span>
          </button>
          {open === c.executionId && <OutputBlock text={c.output || '(no output)'} className="max-h-64 overflow-y-auto bg-canvas/40 px-2 py-1" />}
        </div>
      ))}
      {view.error && <div className="mt-1 text-rose-500">error {view.error.code}: {view.error.message}</div>}
    </div>
  );
}
