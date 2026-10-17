import { memo, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, File, FilePlus, Folder, FolderOpen, GitBranch, Pin, PinOff, Plus, RefreshCw, Search } from 'lucide-react';
import type { CodeWorkspace } from '@neuroflow/contracts';
import { codeApi, type GitStatusEntry, type SearchHit, type TreeEntry } from '@/lib/code-api';
import { cn, relativeTime } from '@/lib/utils';
import { codeKeys, useGit, useRefreshWorkingTree, useTree } from '@/hooks/code';
import { useCode, type ExplorerTab } from '@/stores/code';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { AGENT_BRANCH_PREFIX, GitActions } from './GitActions';
import { errorMessage, inputClass, Segmented } from './shared';

type Node = { name: string; path: string; dir: boolean; children: Node[]; status?: TreeEntry['status'] };

function buildTree(files: TreeEntry[]): Node[] {
  const root: Node = { name: '', path: '', dir: true, children: [] };
  const dirs = new Map<string, Node>([['', root]]);
  for (const f of files) {
    const parts = f.path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      let d = dirs.get(p);
      if (!d) {
        d = { name: parts[i]!, path: p, dir: true, children: [] };
        dirs.set(p, d);
        parent.children.push(d);
      }
      if (f.status && !d.status) d.status = 'modified';
      parent = d;
    }
    parent.children.push({ name: parts.at(-1)!, path: f.path, dir: false, children: [], ...(f.status ? { status: f.status } : {}) });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export const STATUS_STYLE: Record<string, { letter: string; className: string }> = {
  modified: { letter: 'M', className: 'text-amber-600' },
  added: { letter: 'A', className: 'text-emerald-600' },
  untracked: { letter: 'U', className: 'text-emerald-600' },
  deleted: { letter: 'D', className: 'text-rose-500' },
  renamed: { letter: 'R', className: 'text-sky-600' },
  conflicted: { letter: '!', className: 'text-rose-600' },
};

export function Explorer({ workspace, runId }: { workspace: CodeWorkspace; runId: string | null }) {
  const tab = useCode((s) => s.explorerTab);
  const setTab = useCode((s) => s.setExplorerTab);
  const git = useGit(workspace.id, workspace.status);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="explorer">
      <div className="flex h-10 shrink-0 items-center px-2">
        <Segmented<ExplorerTab>
          size="xs"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'files', label: 'Files', testId: 'explorer-files' },
            { id: 'search', label: 'Search', testId: 'explorer-search' },
            { id: 'git', label: 'Git', badge: git.data?.status.length, testId: 'explorer-git' },
            { id: 'branches', label: 'Branches', testId: 'explorer-branches' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'files' && <FilesTab workspace={workspace} />}
        {tab === 'search' && <SearchTab workspace={workspace} />}
        {tab === 'git' && <GitTab workspace={workspace} runId={runId} />}
        {tab === 'branches' && <BranchesTab workspace={workspace} />}
      </div>
    </div>
  );
}

function FilesTab({ workspace }: { workspace: CodeWorkspace }) {
  const tree = useTree(workspace.id, workspace.status);
  const nodes = useMemo(() => buildTree(tree.data?.files ?? []), [tree.data]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const openFile = useCode((s) => s.openFile);
  const refresh = useRefreshWorkingTree(workspace.id);
  const toggle = (p: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const create = useMutation({
    mutationFn: (path: string) => codeApi.saveFile(workspace.id, path, ''),
    onSuccess: (_r, path) => {
      setCreating(false);
      setNewPath('');
      refresh();
      openFile(path);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <div className="pb-4">
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-faint">{workspace.repository.name}</span>
        <div className="flex">
          <Tooltip content="New file">
            <Button variant="ghost" size="icon-sm" className="size-6" onClick={() => setCreating((v) => !v)} aria-label="New file">
              <FilePlus className="size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content="Refresh">
            <Button variant="ghost" size="icon-sm" className="size-6" onClick={refresh} aria-label="Refresh files">
              <RefreshCw className={cn('size-3.5', tree.isFetching && 'animate-spin')} />
            </Button>
          </Tooltip>
        </div>
      </div>
      {creating && (
        <form
          className="px-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (newPath.trim()) create.mutate(newPath.trim());
          }}
        >
          <input autoFocus className={cn(inputClass, 'py-1 font-mono text-xs')} placeholder="path/to/file.ts" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
          {error && <p className="mt-1 text-[11px] text-rose-500">{error}</p>}
        </form>
      )}
      {tree.isLoading && <div className="px-3 py-2 text-xs text-faint">Loading files…</div>}
      {tree.error && <div className="px-3 py-2 text-xs text-rose-500">{errorMessage(tree.error)}</div>}
      <TreeLevel nodes={nodes} depth={0} expanded={expanded} toggle={toggle} />
      {tree.data?.truncated && <div className="px-3 py-2 text-[11px] text-faint">Showing the first {tree.data.files.length} files.</div>}
    </div>
  );
}

const TreeLevel = memo(function TreeLevel({ nodes, depth, expanded, toggle }: { nodes: Node[]; depth: number; expanded: Set<string>; toggle(p: string): void }) {
  const openFile = useCode((s) => s.openFile);
  const activePath = useCode((s) => s.activePath);
  const pinned = useCode((s) => s.pinned);
  const togglePin = useCode((s) => s.togglePin);
  return (
    <>
      {nodes.map((n) => {
        const open = expanded.has(n.path);
        const st = n.status ? STATUS_STYLE[n.status] : undefined;
        return (
          <div key={n.path}>
            <div
              className={cn(
                'group flex h-[26px] cursor-pointer items-center gap-1 pr-2 text-[12.5px] transition-colors',
                !n.dir && activePath === n.path ? 'bg-violet-soft/70 text-ink' : 'text-ink-soft hover:bg-surface/70',
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => (n.dir ? toggle(n.path) : openFile(n.path))}
              title={n.path}
              data-testid={n.dir ? undefined : `file-${n.path}`}
            >
              {n.dir ? (
                <>
                  {open ? <ChevronDown className="size-3 shrink-0 text-faint" /> : <ChevronRight className="size-3 shrink-0 text-faint" />}
                  {open ? <FolderOpen className="size-3.5 shrink-0 text-accent/70" /> : <Folder className="size-3.5 shrink-0 text-accent/70" />}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <File className="size-3.5 shrink-0 text-faint" />
                </>
              )}
              <span className={cn('min-w-0 flex-1 truncate', st?.className, n.status === 'deleted' && 'line-through')}>{n.name}</span>
              {!n.dir && (
                <button
                  className={cn('rounded p-0.5 text-faint hover:text-accent', pinned.includes(n.path) ? 'opacity-100 text-accent' : 'opacity-0 group-hover:opacity-100')}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePin(n.path);
                  }}
                  aria-label={pinned.includes(n.path) ? 'Remove from agent context' : 'Add to agent context'}
                  title={pinned.includes(n.path) ? 'Remove from agent context' : 'Add to agent context'}
                >
                  {pinned.includes(n.path) ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                </button>
              )}
              {st && <span className={cn('w-3 shrink-0 text-center font-mono text-[10px] font-semibold', st.className)}>{n.dir ? '•' : st.letter}</span>}
            </div>
            {n.dir && open && <TreeLevel nodes={n.children} depth={depth + 1} expanded={expanded} toggle={toggle} />}
          </div>
        );
      })}
    </>
  );
});

function SearchTab({ workspace }: { workspace: CodeWorkspace }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'text' | 'regex' | 'symbol' | 'references' | 'files'>('text');
  const revealLine = useCode((s) => s.revealLine);
  const openFile = useCode((s) => s.openFile);
  const search = useMutation({ mutationFn: () => codeApi.search(workspace.id, query.trim(), kind) });
  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of search.data ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m.entries()];
  }, [search.data]);
  return (
    <div className="px-3 pb-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) search.mutate();
        }}
        className="flex flex-col gap-1.5"
      >
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input className={cn(inputClass, 'py-1.5 pl-8 text-xs')} placeholder="Search the repository" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="search-input" />
        </div>
        <select className={cn(inputClass, 'py-1 text-xs')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="text">Text</option>
          <option value="regex">Regular expression</option>
          <option value="symbol">Symbol definition</option>
          <option value="references">References</option>
          <option value="files">File names</option>
        </select>
      </form>
      {search.isPending && <div className="py-3 text-xs text-faint">Searching…</div>}
      {search.error && <div className="py-3 text-xs text-rose-500">{errorMessage(search.error)}</div>}
      {search.data && (
        <div className="mt-3 text-[11px] text-faint">
          {search.data.length} result{search.data.length === 1 ? '' : 's'} in {grouped.length} file{grouped.length === 1 ? '' : 's'}
        </div>
      )}
      <div className="mt-1 flex flex-col gap-2" data-testid="search-results">
        {grouped.map(([path, hits]) => (
          <div key={path}>
            <button className="w-full truncate text-left font-mono text-[11.5px] font-medium text-ink hover:underline" onClick={() => openFile(path)} title={path}>
              {path}
            </button>
            {hits
              .filter((h) => h.line > 0)
              .slice(0, 20)
              .map((h, i) => (
                <button
                  key={i}
                  onClick={() => revealLine(path, h.line)}
                  className="flex w-full gap-2 rounded px-1 py-0.5 text-left font-mono text-[11px] text-ink-soft hover:bg-surface/70"
                >
                  <span className="w-8 shrink-0 text-right text-faint">{h.line}</span>
                  <span className="truncate">{h.text.trim()}</span>
                </button>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function GitTab({ workspace, runId }: { workspace: CodeWorkspace; runId: string | null }) {
  const git = useGit(workspace.id, workspace.status);
  const openFile = useCode((s) => s.openFile);
  const changes: GitStatusEntry[] = git.data?.status ?? [];
  return (
    <div className="flex flex-col gap-3 px-3 pb-4">
      <div className="flex items-center gap-1.5 text-xs text-ink-soft">
        <GitBranch className="size-3.5 text-faint" />
        <span className="truncate font-mono">{git.data?.branch ?? workspace.branch}</span>
      </div>
      <GitActions workspace={workspace} runId={runId} />
      <div>
        <div className="pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Changes ({changes.length})</div>
        {changes.length === 0 && <div className="py-1 text-xs text-faint">No changes</div>}
        {changes.map((c) => {
          const st = STATUS_STYLE[c.kind];
          return (
            <button
              key={c.path}
              onClick={() => openFile(c.path, 'diff')}
              className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs hover:bg-surface/70"
              title={`${c.path} — open diff`}
            >
              <span className={cn('w-3 text-center font-mono text-[10px] font-semibold', st?.className)}>{st?.letter}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{c.path}</span>
            </button>
          );
        })}
      </div>
      <div>
        <div className="pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">History</div>
        {git.data?.log.slice(0, 10).map((c) => (
          <div key={c.sha} className="flex items-baseline gap-2 py-0.5 text-xs">
            <span className="font-mono text-[10.5px] text-accent">{c.sha.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate text-ink-soft" title={c.subject}>
              {c.subject}
            </span>
            <span className="shrink-0 text-[10px] text-faint">{relativeTime(c.date)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BranchesTab({ workspace }: { workspace: CodeWorkspace }) {
  const qc = useQueryClient();
  const git = useGit(workspace.id, workspace.status);
  const refresh = useRefreshWorkingTree(workspace.id);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const after = () => {
    setError(null);
    refresh();
    void qc.invalidateQueries({ queryKey: codeKeys.workspace(workspace.id) });
  };
  const checkout = useMutation({ mutationFn: (b: string) => codeApi.checkout(workspace.id, b), onSuccess: after, onError: (e) => setError(errorMessage(e)) });
  const create = useMutation({
    mutationFn: () => codeApi.createBranch(workspace.id, name.trim()),
    onSuccess: () => {
      setName('');
      after();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <div className="flex flex-col gap-3 px-3 pb-4">
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <input className={cn(inputClass, 'py-1.5 font-mono text-xs')} placeholder="new-task-name" value={name} onChange={(e) => setName(e.target.value)} />
        <Button variant="outline" size="icon-sm" type="submit" aria-label="Create branch" disabled={!name.trim() || create.isPending}>
          <Plus className="size-3.5" />
        </Button>
      </form>
      <p className="-mt-1.5 text-[11px] text-faint">New branches are created as {AGENT_BRANCH_PREFIX}&lt;name&gt;.</p>
      {error && <p className="text-[11px] text-rose-500">{error}</p>}
      <div>
        {git.data?.branches.map((b) => (
          <button
            key={b}
            disabled={b === git.data?.branch || checkout.isPending}
            onClick={() => checkout.mutate(b)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left font-mono text-xs transition',
              b === git.data?.branch ? 'bg-violet-soft/60 text-ink' : 'text-ink-soft hover:bg-surface/70',
            )}
          >
            <GitBranch className={cn('size-3.5 shrink-0', b === git.data?.branch ? 'text-accent' : 'text-faint')} />
            <span className="min-w-0 flex-1 truncate">{b}</span>
            {b === git.data?.baseBranch && <span className="font-sans text-[10px] text-faint">base</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
