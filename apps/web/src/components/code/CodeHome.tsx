import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowRight, Building2, Check, ExternalLink, FolderGit2, GitBranch, Github, KeyRound, Lock, Plus, RefreshCw, Search, Unplug, User } from 'lucide-react';
import type { ApprovalMode, CodeWorkspace } from '@neuroflow/contracts';
import { codeApi } from '@/lib/code-api';
import { cn, relativeTime } from '@/lib/utils';
import { codeKeys, useBranches, useCodeWorkspaces, useConnections, useGithubConfig, useOwners, useRepos } from '@/hooks/code';
import { useSession } from '@/hooks/queries';
import { navigateTo, useDocumentTitle, useSearchParam } from '@/hooks/route';
import { useToasts } from '@/stores/toasts';
import { Button } from '@/components/ui/button';
import { Logo, Sparkle } from '@/components/ui/sparkle';
import { AppSwitcher } from '@/components/layout/AppSwitcher';
import { APPROVAL_MODES, errorMessage, inputClass, StatusDot } from './shared';

/** Code home: Connect GitHub → account/organization → repository → branch → code workspace. */
export function CodeHome() {
  useDocumentTitle('Code · NeuroFlow');
  const pushToast = useToasts((s) => s.push);
  const connected = useSearchParam('github');
  useEffect(() => {
    if (connected === 'connected') {
      pushToast({ tone: 'success', title: 'GitHub connected' });
      navigateTo('/code', { replace: true });
    }
  }, [connected, pushToast]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="glass flex h-14 shrink-0 items-center gap-3 rounded-[22px] px-4">
        <Logo className="size-7" />
        <div className="text-sm font-semibold text-ink">NeuroFlow Code</div>
        <AppSwitcher className="ml-4" />
      </header>
      <main className="glass min-h-0 flex-1 overflow-y-auto rounded-[28px]">
        <div className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Open a repository</h1>
            <p className="mt-1.5 text-sm text-muted">
              Connect GitHub, pick a repository and branch, and work with the Code Agent in an isolated workspace. Credentials stay on the server.
            </p>
            <NewWorkspace />
          </section>
          <section>
            <WorkspaceList />
          </section>
        </div>
      </main>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <div className="relative pl-10">
      <div
        className={cn(
          'absolute left-0 top-0 flex size-7 items-center justify-center rounded-full text-xs font-semibold',
          done ? 'bg-mint-soft text-emerald-600' : 'bg-violet-soft text-accent',
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </div>
      <div className="pt-1 text-sm font-semibold text-ink">{title}</div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function NewWorkspace() {
  const qc = useQueryClient();
  const { data: me } = useSession();
  const { data: config } = useGithubConfig();
  const { data: connections = [], isLoading: loadingConnections } = useConnections();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<ApprovalMode>('review');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [localPath, setLocalPath] = useState('');
  const [localBranch, setLocalBranch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connectionId && connections[0]) setConnectionId(connections[0].id);
    if (connectionId && !connections.some((c) => c.id === connectionId)) setConnectionId(connections[0]?.id ?? null);
  }, [connections, connectionId]);
  const owners = useOwners(connectionId);
  useEffect(() => {
    if (owners.data?.[0] && !owners.data.some((o) => o.login === owner)) setOwner(owners.data[0].login);
  }, [owners.data, owner]);
  const repos = useRepos(connectionId, owner);
  const selectedRepo = repos.data?.find((r) => r.name === repo) ?? null;
  const branches = useBranches(connectionId, owner, repo);
  useEffect(() => {
    if (selectedRepo && (!branch || !branches.data?.some((b) => b.name === branch))) setBranch(selectedRepo.defaultBranch);
  }, [selectedRepo, branches.data, branch]);

  const filtered = useMemo(
    () => (repos.data ?? []).filter((r) => r.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 100),
    [repos.data, filter],
  );

  const connect = useMutation({
    mutationFn: () => codeApi.connectToken(token.trim()),
    onSuccess: ({ connection }) => {
      setToken('');
      setShowToken(false);
      setConnectionId(connection.id);
      void qc.invalidateQueries({ queryKey: codeKeys.connections });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const oauth = useMutation({
    mutationFn: codeApi.oauthStart,
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) => setError(errorMessage(err)),
  });
  const disconnect = useMutation({
    mutationFn: codeApi.disconnect,
    onSuccess: () => void qc.invalidateQueries({ queryKey: codeKeys.connections }),
  });
  const create = useMutation({
    mutationFn: () =>
      localPath.trim()
        ? codeApi.createWorkspace({ provider: 'local', path: localPath.trim(), approvalMode: mode, ...(localBranch.trim() ? { branch: localBranch.trim() } : {}) })
        : codeApi.createWorkspace({ provider: 'github', connectionId: connectionId!, owner: owner!, repo: repo!, branch: branch ?? undefined, approvalMode: mode }),
    onSuccess: ({ workspace }) => {
      void qc.invalidateQueries({ queryKey: codeKeys.workspaces });
      navigateTo(`/code/${workspace.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const connection = connections.find((c) => c.id === connectionId);
  const canCreate = localPath.trim() ? true : Boolean(connectionId && owner && repo && branch);

  return (
    <div className="glass-strong mt-6 flex flex-col gap-6 rounded-[24px] p-6" data-testid="new-workspace">
      <Step n={1} title="Connect GitHub" done={Boolean(connection)}>
        {loadingConnections ? (
          <div className="h-9 animate-pulse rounded-xl bg-surface/70" />
        ) : (
          <div className="flex flex-col gap-2">
            {connections.map((c) => (
              <div
                key={c.id}
                className={cn(
                  'flex items-center gap-3 rounded-xl border px-3 py-2 text-sm transition',
                  c.id === connectionId ? 'border-accent/40 bg-violet-soft/40' : 'border-line bg-surface/60 hover:bg-surface',
                )}
              >
                <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => setConnectionId(c.id)}>
                  <Github className="size-4 shrink-0 text-ink" />
                  <span className="truncate font-medium text-ink">{c.login}</span>
                  <span className="rounded-full bg-surface px-2 text-[10px] uppercase tracking-wide text-muted">{c.kind === 'oauth' ? 'OAuth' : 'Token'}</span>
                </button>
                <button
                  className="rounded-full p-1.5 text-faint transition hover:bg-rose-soft hover:text-rose-500"
                  onClick={() => disconnect.mutate(c.id)}
                  aria-label={`Disconnect ${c.login}`}
                  title="Disconnect (the stored token is deleted)"
                >
                  <Unplug className="size-3.5" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              {config?.oauth && (
                <Button variant="primary" size="sm" onClick={() => oauth.mutate()} disabled={oauth.isPending}>
                  <Github className="size-3.5" /> {connections.length ? 'Connect another account' : 'Connect with GitHub'}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setShowToken((v) => !v)} data-testid="connect-token">
                <KeyRound className="size-3.5" /> Use an access token
              </Button>
            </div>
            {showToken && (
              <form
                className="flex flex-col gap-2 rounded-xl bg-surface/60 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  setError(null);
                  connect.mutate();
                }}
              >
                <p className="text-xs leading-5 text-muted">
                  Use a{' '}
                  <a className="text-accent underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                    fine-grained token
                  </a>{' '}
                  limited to the repositories you want, with Contents (read/write), Pull requests (read/write) and Metadata (read). It is encrypted at rest and never sent to models or the browser again.
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    className={inputClass}
                    placeholder="github_pat_…"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    data-testid="github-token"
                  />
                  <Button variant="primary" size="md" type="submit" disabled={token.trim().length < 20 || connect.isPending}>
                    Connect
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
      </Step>

      <Step n={2} title="Choose a repository" done={Boolean(repo)}>
        {!connection ? (
          <p className="text-xs text-faint">Connect GitHub first.</p>
        ) : owners.error ? (
          <p className="text-xs text-rose-500">{errorMessage(owners.error)}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {(owners.data ?? []).map((o) => (
                <button
                  key={o.login}
                  onClick={() => {
                    setOwner(o.login);
                    setRepo(null);
                  }}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs transition',
                    o.login === owner ? 'bg-ink text-canvas' : 'bg-surface/70 text-ink-soft hover:bg-surface',
                  )}
                >
                  {o.type === 'Organization' ? <Building2 className="size-3" /> : <User className="size-3" />}
                  {o.login}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <input className={cn(inputClass, 'pl-8')} placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="max-h-64 overflow-y-auto rounded-xl border border-line bg-surface/50" data-testid="repo-list">
              {repos.isLoading && <div className="px-3 py-4 text-center text-xs text-faint">Loading repositories…</div>}
              {repos.error && <div className="px-3 py-4 text-center text-xs text-rose-500">{errorMessage(repos.error)}</div>}
              {repos.data && filtered.length === 0 && <div className="px-3 py-4 text-center text-xs text-faint">No repositories</div>}
              {filtered.map((r) => (
                <button
                  key={r.fullName}
                  onClick={() => setRepo(r.name)}
                  className={cn(
                    'flex w-full items-start gap-2.5 border-b border-line/60 px-3 py-2 text-left last:border-0 transition',
                    r.name === repo ? 'bg-violet-soft/50' : 'hover:bg-surface',
                  )}
                >
                  <FolderGit2 className="mt-0.5 size-4 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm text-ink">
                      <span className="truncate font-medium">{r.name}</span>
                      {r.private && <Lock className="size-3 text-faint" />}
                      {!r.permissions.push && <span className="rounded-full bg-peach-soft px-1.5 text-[10px] text-amber-700">read-only</span>}
                    </div>
                    {r.description && <div className="truncate text-xs text-muted">{r.description}</div>}
                  </div>
                  <span className="shrink-0 text-[11px] text-faint">{relativeTime(r.updatedAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Step>

      <Step n={3} title="Branch and approval mode" done={Boolean(repo && branch)}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-faint" />
            <select
              className={cn(inputClass, 'w-auto min-w-48')}
              value={branch ?? ''}
              onChange={(e) => setBranch(e.target.value)}
              disabled={!branches.data?.length}
              data-testid="branch-select"
            >
              {!branches.data?.length && <option value="">{repo ? 'Loading branches…' : 'Select a repository'}</option>}
              {branches.data?.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.protected ? ' (protected)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {APPROVAL_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={cn(
                  'flex items-start gap-2.5 rounded-xl border p-2.5 text-left transition',
                  mode === m.id ? 'border-accent/40 bg-violet-soft/40' : 'border-line bg-surface/50 hover:bg-surface',
                )}
              >
                <m.icon className={cn('mt-0.5 size-4 shrink-0', mode === m.id ? 'text-accent' : 'text-faint')} />
                <div>
                  <div className="text-xs font-semibold text-ink">{m.label}</div>
                  <div className="mt-0.5 text-[11px] leading-4 text-muted">{m.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </Step>

      {me?.authMode === 'dev' && (
        <details className="rounded-xl bg-surface/50 px-3 py-2 text-xs text-muted">
          <summary className="cursor-pointer select-none">Development: open a local Git repository instead</summary>
          <input
            className={cn(inputClass, 'mt-2 font-mono text-xs')}
            placeholder="Absolute path to a local repository (it is cloned into an isolated workspace)"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            data-testid="local-path"
          />
          <input
            className={cn(inputClass, 'mt-2 font-mono text-xs')}
            placeholder="Branch (default: main)"
            value={localBranch}
            onChange={(e) => setLocalBranch(e.target.value)}
            data-testid="local-branch"
          />
        </details>
      )}

      {error && (
        <div className="rounded-xl bg-rose-soft px-3 py-2 text-xs text-rose-600" role="alert">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="md"
          disabled={!canCreate || create.isPending}
          onClick={() => {
            setError(null);
            create.mutate();
          }}
          data-testid="create-workspace"
        >
          {create.isPending ? <Sparkle className="size-4" animated /> : <Plus className="size-4" />}
          Create workspace
        </Button>
      </div>
    </div>
  );
}

function WorkspaceList() {
  const qc = useQueryClient();
  const { data: workspaces, isLoading } = useCodeWorkspaces();
  const archive = useMutation({
    mutationFn: codeApi.archiveWorkspace,
    onSuccess: () => void qc.invalidateQueries({ queryKey: codeKeys.workspaces }),
  });
  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Your workspaces</h2>
        <Button variant="ghost" size="icon-sm" onClick={() => void qc.invalidateQueries({ queryKey: codeKeys.workspaces })} aria-label="Refresh">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <div className="mt-3 flex flex-col gap-2" data-testid="workspace-list">
        {isLoading && <div className="h-16 animate-pulse rounded-2xl bg-surface/60" />}
        {workspaces?.length === 0 && (
          <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-xs leading-5 text-faint">
            Workspaces you create appear here. Each one is an isolated checkout of a repository branch.
          </div>
        )}
        {workspaces?.map((w, i) => (
          <motion.div key={w.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
            <WorkspaceRow w={w} onArchive={() => archive.mutate(w.id)} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function WorkspaceRow({ w, onArchive }: { w: CodeWorkspace; onArchive(): void }) {
  return (
    <div className="glass-strong group flex items-center gap-3 rounded-2xl px-4 py-3">
      <StatusDot status={w.status} />
      <button className="min-w-0 flex-1 text-left" onClick={() => navigateTo(`/code/${w.id}`)}>
        <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <span className="truncate">{w.repository.fullName}</span>
          {w.repository.private && <Lock className="size-3 text-faint" />}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
          <GitBranch className="size-3" />
          <span className="truncate font-mono">{w.branch}</span>
          <span>·</span>
          <span className="capitalize">{w.approvalMode}</span>
          <span>·</span>
          <span>{w.status === 'error' ? (w.error ?? 'error') : w.lastSyncedAt ? `synced ${relativeTime(w.lastSyncedAt)}` : w.status}</span>
        </div>
      </button>
      {w.repository.htmlUrl && (
        <a href={w.repository.htmlUrl} target="_blank" rel="noreferrer" className="rounded-full p-1.5 text-faint opacity-0 transition hover:text-ink group-hover:opacity-100" aria-label="Open on GitHub">
          <ExternalLink className="size-3.5" />
        </a>
      )}
      <button onClick={onArchive} className="rounded-full p-1.5 text-faint opacity-0 transition hover:bg-rose-soft hover:text-rose-500 group-hover:opacity-100" aria-label="Archive workspace">
        <Archive className="size-3.5" />
      </button>
      <button onClick={() => navigateTo(`/code/${w.id}`)} className="rounded-full p-1.5 text-faint transition hover:text-accent" aria-label="Open workspace">
        <ArrowRight className="size-4" />
      </button>
    </div>
  );
}
