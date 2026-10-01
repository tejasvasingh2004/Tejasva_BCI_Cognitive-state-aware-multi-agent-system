import { useCallback, useEffect, useRef } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Command, ExternalLink, GitBranch, Loader2, Lock, PanelBottom, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import type { ApprovalMode, CodeWorkspace as CodeWorkspaceT } from '@neuroflow/contracts';
import { codeApi } from '@/lib/code-api';
import { cn, relativeTime } from '@/lib/utils';
import { codeKeys, useCodeWorkspace, useGit, useWorkspaceEvents } from '@/hooks/code';
import { navigateTo, useDocumentTitle } from '@/hooks/route';
import { useCode } from '@/stores/code';
import { Button } from '@/components/ui/button';
import { Logo, Sparkle } from '@/components/ui/sparkle';
import { Tooltip } from '@/components/ui/tooltip';
import { AppSwitcher } from '@/components/layout/AppSwitcher';
import { AgentPanel, type AgentPanelHandle, useAgentRunner } from './AgentPanel';
import { BottomPanel } from './BottomPanel';
import { CommandBar } from './CommandBar';
import { disposeWorkspaceModels, EditorArea, type AgentAction } from './EditorArea';
import { Explorer } from './Explorer';
import { APPROVAL_MODES, errorMessage, StatusDot } from './shared';

/**
 * The Phase 2 code workspace:
 *   Repository / Branch / Workspace
 *   ├── Repository Explorer   ├── Monaco Editor   ├── AI Agent
 *   └── Terminal | Problems | Tests | Git Diff | Agent Logs
 */
export function CodeWorkspace({ id }: { id: string }) {
  const { data, error, isLoading } = useCodeWorkspace(id);
  const open = useCode((s) => s.open);
  useEffect(() => {
    open(id);
    return () => disposeWorkspaceModels(id);
  }, [id, open]);
  useDocumentTitle(data ? `${data.workspace.repository.name} · NeuroFlow Code` : 'NeuroFlow Code');

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Sparkle className="size-7" animated />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <AlertTriangle className="size-8 text-rose-400" />
        <div className="text-sm text-ink">{errorMessage(error, 'Workspace not found')}</div>
        <Button variant="outline" size="sm" onClick={() => navigateTo('/code')}>
          <ArrowLeft className="size-3.5" /> All workspaces
        </Button>
      </div>
    );
  }
  return <WorkspaceShell workspace={data.workspace} commands={data.commands} sandboxAvailable={data.sandboxAvailable} />;
}

function WorkspaceShell({ workspace, commands, sandboxAvailable }: { workspace: CodeWorkspaceT; commands: Record<string, string>; sandboxAvailable: boolean }) {
  const connection = useWorkspaceEvents(workspace.id);
  const bottomOpen = useCode((s) => s.bottomOpen);
  const setBottomOpen = useCode((s) => s.setBottomOpen);
  const setCommandBarOpen = useCode((s) => s.setCommandBarOpen);
  const setExplorerTab = useCode((s) => s.setExplorerTab);
  const setBottomTab = useCode((s) => s.setBottomTab);
  const upsertTerminal = useCode((s) => s.upsertTerminal);
  const runId = useCode((s) => s.activeRun[workspace.id] ?? null);
  const agentRef = useRef<AgentPanelHandle>(null);
  const runner = useAgentRunner(workspace);

  const onAgentAction = useCallback((a: AgentAction) => agentRef.current?.ask(a), []);
  const onAsk = useCallback((text: string) => runner.mutate({ instruction: text }), [runner]);
  const onRunCommand = useCallback(
    (command: string, kind: 'install' | 'test' | 'lint' | 'build') => {
      setBottomTab('terminal');
      void codeApi.runCommand(workspace.id, command, kind).then((r) => upsertTerminal(r.correlationId, { command, kind, status: 'queued', network: r.network }));
    },
    [workspace.id, setBottomTab, upsertTerminal],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k' || (k === 'p' && !e.shiftKey)) {
        e.preventDefault();
        setCommandBarOpen(true);
      } else if (k === 'l') {
        e.preventDefault();
        agentRef.current?.focus();
      } else if (k === '`' || k === 'j') {
        e.preventDefault();
        setBottomOpen(!useCode.getState().bottomOpen);
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault();
        setExplorerTab('search');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setCommandBarOpen, setBottomOpen, setExplorerTab]);

  const ready = workspace.status === 'ready' || workspace.status === 'syncing';
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <TopBar workspace={workspace} connection={connection} />
      {!ready ? (
        <Provisioning workspace={workspace} />
      ) : (
        <Group orientation="horizontal" className="min-h-0 flex-1" id="code-h">
          <Panel id="p-explorer" defaultSize="18" minSize={180} maxSize="35" className="glass rounded-[20px]">
            <Explorer workspace={workspace} runId={runId} />
          </Panel>
          <Separator className="w-2 outline-none transition-colors data-[separator=hover]:bg-accent/10 data-[separator=active]:bg-accent/20" />
          <Panel id="p-center" minSize={320}>
            <Group orientation="vertical" id="code-v" className="h-full">
              <Panel id="p-editor" minSize={160} className="glass overflow-hidden rounded-[20px]">
                <EditorArea workspace={workspace} onAgentAction={onAgentAction} />
              </Panel>
              {bottomOpen && (
                <>
                  <Separator className="h-2 outline-none data-[separator=hover]:bg-accent/10 data-[separator=active]:bg-accent/20" />
                  <Panel id="p-bottom" defaultSize="32" minSize={120} className="glass overflow-hidden rounded-[20px]">
                    <BottomPanel workspace={workspace} commands={commands} sandboxAvailable={sandboxAvailable} />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          <Separator className="w-2 outline-none data-[separator=hover]:bg-accent/10 data-[separator=active]:bg-accent/20" />
          <Panel id="p-agent" defaultSize="28" minSize={300} maxSize="50" className="glass overflow-hidden rounded-[20px]">
            <AgentPanel ref={agentRef} workspace={workspace} />
          </Panel>
        </Group>
      )}
      {ready && <CommandBar workspace={workspace} commands={commands} onAsk={onAsk} onAction={onAgentAction} onRunCommand={onRunCommand} />}
    </div>
  );
}

function TopBar({ workspace, connection }: { workspace: CodeWorkspaceT; connection: string }) {
  const qc = useQueryClient();
  const git = useGit(workspace.id, workspace.status);
  const bottomOpen = useCode((s) => s.bottomOpen);
  const setBottomOpen = useCode((s) => s.setBottomOpen);
  const setCommandBarOpen = useCode((s) => s.setCommandBarOpen);
  const setExplorerTab = useCode((s) => s.setExplorerTab);
  const setApprovalMode = useCode((s) => s.setApprovalMode);
  const sync = useMutation({
    mutationFn: () => codeApi.sync(workspace.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: codeKeys.workspace(workspace.id) }),
  });
  const updateMode = useMutation({
    mutationFn: (mode: ApprovalMode) => codeApi.updateWorkspace(workspace.id, { approvalMode: mode }),
    onSuccess: (_r, mode) => {
      setApprovalMode(workspace.id, mode);
      void qc.invalidateQueries({ queryKey: codeKeys.workspace(workspace.id) });
    },
  });
  const branch = git.data?.branch ?? workspace.branch;
  const changes = git.data?.status.length ?? 0;
  return (
    <header className="glass flex h-12 shrink-0 items-center gap-2 rounded-[20px] px-3" data-testid="code-topbar">
      <button onClick={() => navigateTo('/code')} className="flex items-center gap-2" aria-label="All workspaces">
        <Logo className="size-6" />
      </button>
      <AppSwitcher compact className="hidden md:flex" />
      <div className="mx-1 h-5 w-px bg-line" />
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="truncate font-semibold text-ink" data-testid="repo-name">
          {workspace.repository.fullName}
        </span>
        {workspace.repository.private && <Lock className="size-3 shrink-0 text-faint" />}
        {workspace.repository.htmlUrl && (
          <a href={workspace.repository.htmlUrl} target="_blank" rel="noreferrer" className="text-faint hover:text-ink" aria-label="Open on GitHub">
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <button
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-surface/70 px-2.5 font-mono text-[11.5px] text-ink-soft hover:bg-surface"
        onClick={() => setExplorerTab('branches')}
        title="Branches"
        data-testid="branch-name"
      >
        <GitBranch className="size-3 shrink-0 text-accent" />
        <span className="max-w-56 truncate">{branch}</span>
        {changes > 0 && <span className="font-sans text-[10px] text-amber-600">● {changes}</span>}
      </button>
      <div className="hidden items-center gap-1.5 text-[11px] text-muted lg:flex">
        <StatusDot status={workspace.status} />
        {workspace.status === 'syncing' ? 'Syncing…' : workspace.lastSyncedAt ? `Synced ${relativeTime(workspace.lastSyncedAt)}` : workspace.status}
        {workspace.headCommit && <span className="font-mono text-faint">{workspace.headCommit.slice(0, 7)}</span>}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Tooltip content="Default approval mode for this workspace">
          <select
            value={workspace.approvalMode}
            onChange={(e) => updateMode.mutate(e.target.value as ApprovalMode)}
            className="h-7 rounded-full bg-violet-soft/60 px-2.5 text-[11.5px] font-medium text-accent outline-none"
            aria-label="Workspace approval mode"
          >
            {APPROVAL_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} mode
              </option>
            ))}
          </select>
        </Tooltip>
        <Tooltip content="Fetch and fast-forward from the remote">
          <Button variant="ghost" size="icon-sm" onClick={() => sync.mutate()} disabled={sync.isPending || workspace.status === 'syncing'} aria-label="Sync">
            <RefreshCw className={cn('size-3.5', (sync.isPending || workspace.status === 'syncing') && 'animate-spin')} />
          </Button>
        </Tooltip>
        <Tooltip content="Command bar (Ctrl+K)">
          <Button variant="ghost" size="icon-sm" onClick={() => setCommandBarOpen(true)} aria-label="Command bar" data-testid="open-command-bar">
            <Command className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Toggle panel (Ctrl+`)">
          <Button variant="ghost" size="icon-sm" className={cn(bottomOpen && 'text-accent')} onClick={() => setBottomOpen(!bottomOpen)} aria-label="Toggle bottom panel">
            <PanelBottom className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={connection === 'open' ? 'Live updates connected' : 'Reconnecting to live updates…'}>
          <span className={cn('flex size-7 items-center justify-center', connection === 'open' ? 'text-emerald-500' : 'text-amber-500')}>
            {connection === 'open' ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
          </span>
        </Tooltip>
      </div>
    </header>
  );
}

function Provisioning({ workspace }: { workspace: CodeWorkspaceT }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => codeApi.sync(workspace.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: codeKeys.workspace(workspace.id) }),
  });
  return (
    <div className="glass flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-[24px] p-8 text-center" data-testid="provisioning">
      {workspace.status === 'error' ? (
        <>
          <AlertTriangle className="size-8 text-rose-400" />
          <div className="text-sm font-medium text-ink">The workspace could not be prepared</div>
          <div className="max-w-md text-xs text-muted">{workspace.error}</div>
          <Button variant="outline" size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
            <RefreshCw className="size-3.5" /> Try again
          </Button>
        </>
      ) : (
        <>
          <Loader2 className="size-7 animate-spin text-accent" />
          <div className="text-sm font-medium text-ink">Cloning {workspace.repository.fullName}</div>
          <div className="text-xs text-muted">Preparing an isolated checkout of {workspace.branch}. This page updates when it is ready.</div>
        </>
      )}
    </div>
  );
}
