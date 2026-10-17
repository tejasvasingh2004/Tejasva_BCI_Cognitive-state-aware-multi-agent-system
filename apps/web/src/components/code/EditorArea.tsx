import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type BeforeMount, type OnMount } from '@monaco-editor/react';
import { useQuery } from '@tanstack/react-query';
import { Bug, Code2, FileCode2, FileDiff, Loader2, Save, Sparkles, X } from 'lucide-react';
import type { CodeWorkspace } from '@neuroflow/contracts';
import { codeApi } from '@/lib/code-api';
import { languageFor, monaco } from '@/lib/monaco';
import { cn } from '@/lib/utils';
import { codeKeys, useGit, useRefreshWorkingTree } from '@/hooks/code';
import { useIsDark } from '@/hooks/theme';
import { isDirty, useCode, type Marker } from '@/stores/code';
import { useToasts } from '@/stores/toasts';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { STATUS_STYLE } from './Explorer';
import { errorMessage } from './shared';

export type AgentAction = 'explain' | 'fix' | 'refactor' | 'optimize' | 'write_tests' | 'find_bug' | 'find_security_issue' | 'document';

export const AGENT_ACTIONS: Array<{ id: AgentAction; label: string; prompt: string }> = [
  { id: 'explain', label: 'Explain', prompt: 'Explain what this code does and how it fits into the repository.' },
  { id: 'fix', label: 'Fix', prompt: 'Find and fix the problem in this code. Run the relevant tests afterwards.' },
  { id: 'refactor', label: 'Refactor', prompt: 'Refactor this code for clarity and maintainability without changing behavior.' },
  { id: 'optimize', label: 'Optimize', prompt: 'Improve the performance of this code without changing behavior.' },
  { id: 'write_tests', label: 'Write tests', prompt: 'Write tests for this code following the repository conventions, then run them.' },
  { id: 'find_bug', label: 'Find bugs', prompt: 'Review this code for bugs and explain each one you find.' },
  { id: 'find_security_issue', label: 'Find security issues', prompt: 'Review this code for security issues and explain each one you find.' },
  { id: 'document', label: 'Document', prompt: 'Add concise documentation comments to this code.' },
];

const modelUri = (workspaceId: string, path: string) => `file:///${workspaceId.slice(0, 8)}/${path}`;

const defineThemes: BeforeMount = (m) => {
  m.editor.defineTheme('neuroflow-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#fdfcff',
      'editor.lineHighlightBackground': '#f4f0fd',
      'editorLineNumber.foreground': '#b3b0c7',
      'editorLineNumber.activeForeground': '#7c3aed',
      'editor.selectionBackground': '#ddd0fb',
      'editorGutter.background': '#fdfcff',
    },
  });
  m.editor.defineTheme('neuroflow-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#151226',
      'editor.lineHighlightBackground': '#1d1a33',
      'editorLineNumber.foreground': '#4d4968',
      'editorLineNumber.activeForeground': '#a78bfa',
      'editor.selectionBackground': '#3b2f6b',
      'editorGutter.background': '#151226',
    },
  });
};

/** Disposes a workspace's Monaco models when the workspace closes. */
export function disposeWorkspaceModels(workspaceId: string) {
  const prefix = modelUri(workspaceId, '');
  for (const m of monaco.editor.getModels()) if (m.uri.toString().startsWith(prefix)) m.dispose();
}

export function EditorArea({ workspace, onAgentAction }: { workspace: CodeWorkspace; onAgentAction(action: AgentAction): void }) {
  const tabs = useCode((s) => s.tabs);
  const activePath = useCode((s) => s.activePath);
  const buffers = useCode((s) => s.buffers);
  const setActive = useCode((s) => s.setActive);
  const closeTab = useCode((s) => s.closeTab);
  const setTabMode = useCode((s) => s.setTabMode);
  const git = useGit(workspace.id, workspace.status);
  const statusOf = useMemo(() => new Map((git.data?.status ?? []).map((s) => [s.path, s.kind])), [git.data]);
  const active = tabs.find((t) => t.path === activePath) ?? null;
  const selection = useCode((s) => s.selection);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="editor-area">
      <div className="flex h-10 shrink-0 items-center border-b border-line/70">
        <div className="flex min-w-0 flex-1 items-end overflow-x-auto" role="tablist" aria-label="Open files">
          {tabs.map((t) => {
            const dirty = isDirty(buffers[t.path]);
            const st = statusOf.get(t.path);
            return (
              <div
                key={t.path}
                role="tab"
                aria-selected={t.path === activePath}
                className={cn(
                  'group flex h-10 shrink-0 cursor-pointer items-center gap-1.5 border-r border-line/60 pl-3 pr-1.5 text-xs transition',
                  t.path === activePath ? 'bg-surface text-ink' : 'text-muted hover:bg-surface/50 hover:text-ink',
                )}
                onClick={() => setActive(t.path)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
                title={t.path}
                data-testid={`tab-${t.path}`}
              >
                {t.mode === 'diff' ? <FileDiff className="size-3.5 text-accent" /> : <FileCode2 className="size-3.5 text-faint" />}
                <span className={cn('max-w-40 truncate', st && STATUS_STYLE[st]?.className)}>{t.path.split('/').pop()}</span>
                <button
                  className="flex size-5 items-center justify-center rounded text-faint hover:bg-line/60 hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dirty && !window.confirm(`Discard unsaved changes to ${t.path}?`)) return;
                    closeTab(t.path);
                  }}
                  aria-label={`Close ${t.path}`}
                >
                  {dirty ? <span className="size-2 rounded-full bg-accent group-hover:hidden" /> : null}
                  <X className={cn('size-3', dirty && 'hidden group-hover:block')} />
                </button>
              </div>
            );
          })}
        </div>
        {active && (
          <div className="flex shrink-0 items-center gap-1 px-2">
            <Tooltip content={active.mode === 'diff' ? 'Edit file' : 'Compare with HEAD'}>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn('size-7', active.mode === 'diff' && 'text-accent')}
                onClick={() => setTabMode(active.path, active.mode === 'diff' ? 'edit' : 'diff')}
                aria-label="Toggle diff"
                data-testid="toggle-diff"
              >
                {active.mode === 'diff' ? <Code2 className="size-3.5" /> : <FileDiff className="size-3.5" />}
              </Button>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2.5" data-testid="ask-ai">
                  <Sparkles className="size-3.5 text-accent" /> Ask AI
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{selection && selection.path === active.path ? `Lines ${selection.startLine}–${selection.endLine}` : 'Whole file'}</DropdownMenuLabel>
                {AGENT_ACTIONS.map((a) => (
                  <DropdownMenuItem key={a.id} onSelect={() => onAgentAction(a.id)}>
                    {a.id === 'find_bug' ? <Bug className="size-3.5" /> : <Sparkles className="size-3.5" />} {a.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Selection is sent as context; nothing is applied without your approval mode.</DropdownMenuLabel>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {active ? (
          active.mode === 'diff' ? (
            <FileDiffView key={`diff-${active.path}`} workspace={workspace} path={active.path} />
          ) : (
            <FileEditor key={workspace.id} workspace={workspace} path={active.path} onAgentAction={onAgentAction} />
          )
        ) : (
          <EmptyEditor workspace={workspace} />
        )}
      </div>
    </div>
  );
}

function useFileContent(workspaceId: string, path: string) {
  const buffer = useCode((s) => s.buffers[path]);
  const loadBuffer = useCode((s) => s.loadBuffer);
  const q = useQuery({
    queryKey: codeKeys.file(workspaceId, path),
    queryFn: () => codeApi.file(workspaceId, path),
    enabled: !buffer,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (!buffer && q.data && !q.data.binary) loadBuffer(path, q.data.content ?? '');
  }, [buffer, q.data, loadBuffer, path]);
  return { buffer, query: q };
}

function FileEditor({ workspace, path, onAgentAction }: { workspace: CodeWorkspace; path: string; onAgentAction(a: AgentAction): void }) {
  const { buffer, query } = useFileContent(workspace.id, path);
  const editBuffer = useCode((s) => s.editBuffer);
  const markSaved = useCode((s) => s.markSaved);
  const setSelection = useCode((s) => s.setSelection);
  const setMarkers = useCode((s) => s.setMarkers);
  const resolveConflict = useCode((s) => s.resolveConflict);
  const reveal = useCode((s) => s.reveal);
  const pushToast = useToasts((s) => s.push);
  const refresh = useRefreshWorkingTree(workspace.id);
  const dark = useIsDark();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const actionRef = useRef(onAgentAction);
  actionRef.current = onAgentAction;
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    const p = pathRef.current;
    const b = useCode.getState().buffers[p];
    if (!b || !isDirty(b)) return;
    setSaving(true);
    try {
      await codeApi.saveFile(workspace.id, p, b.content);
      markSaved(p, b.content);
      refresh();
    } catch (err) {
      pushToast({ tone: 'error', title: `Could not save ${p}`, body: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }, [workspace.id, markSaved, refresh, pushToast]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const onMount: OnMount = (editor, m) => {
    editorRef.current = editor;
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => void saveRef.current());
    for (const a of AGENT_ACTIONS.slice(0, 5)) {
      editor.addAction({ id: `neuroflow.${a.id}`, label: `NeuroFlow: ${a.label}`, contextMenuGroupId: '0_neuroflow', run: () => actionRef.current(a.id) });
    }
    editor.onDidChangeCursorSelection((e) => {
      const model = editor.getModel();
      const sel = e.selection;
      if (!model || sel.isEmpty()) {
        setSelection(null);
        return;
      }
      setSelection({ path: pathRef.current, startLine: sel.startLineNumber, endLine: sel.endLineNumber, text: model.getValueInRange(sel).slice(0, 20_000) });
    });
  };

  // External changes (agent edits, commands, sync) update clean buffers; mirror them into the model.
  useEffect(() => {
    const model = monaco.editor.getModel(monaco.Uri.parse(modelUri(workspace.id, path)));
    if (buffer && model && model.getValue() !== buffer.content) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: buffer.content }], () => null);
    }
  }, [buffer?.content, workspace.id, path, buffer]);

  useEffect(() => {
    if (reveal && reveal.path === path && editorRef.current) {
      editorRef.current.revealLineInCenter(reveal.line);
      editorRef.current.setPosition({ lineNumber: reveal.line, column: 1 });
      editorRef.current.focus();
    }
  }, [reveal, path, buffer !== undefined]);

  // Diagnostics from Monaco language services feed the Problems panel.
  useEffect(() => {
    const prefix = modelUri(workspace.id, '');
    const collect = () => {
      const markers: Marker[] = monaco.editor
        .getModelMarkers({})
        .filter((mk) => mk.resource.toString().startsWith(prefix))
        .map((mk) => ({
          path: decodeURIComponent(mk.resource.toString().slice(prefix.length)),
          line: mk.startLineNumber,
          column: mk.startColumn,
          severity: mk.severity === monaco.MarkerSeverity.Error ? 'error' : mk.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info',
          message: mk.message,
          ...(mk.source ? { source: mk.source } : {}),
        }));
      setMarkers(markers);
    };
    const sub = monaco.editor.onDidChangeMarkers(collect);
    collect();
    return () => sub.dispose();
  }, [workspace.id, setMarkers]);

  if (query.error && !buffer) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-xs text-rose-500">{errorMessage(query.error)}</div>;
  }
  if (query.data?.binary) {
    return <div className="flex h-full items-center justify-center text-xs text-faint">Binary file ({Math.round(query.data.size / 1024)} KB) — not shown</div>;
  }
  if (!buffer) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-faint" />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      {buffer.conflict !== undefined && (
        <div className="flex shrink-0 items-center gap-2 bg-peach-soft px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200" role="alert">
          <span className="flex-1">This file changed in the workspace while you had unsaved edits.</span>
          <Button variant="outline" size="sm" className="h-6" onClick={() => resolveConflict(path, 'theirs')}>
            Load workspace version
          </Button>
          <Button variant="ghost" size="sm" className="h-6" onClick={() => resolveConflict(path, 'mine')}>
            Keep mine
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Editor
          path={modelUri(workspace.id, path)}
          defaultValue={buffer.content}
          defaultLanguage={languageFor(path)}
          language={languageFor(path)}
          theme={dark ? 'neuroflow-dark' : 'neuroflow-light'}
          beforeMount={defineThemes}
          onMount={onMount}
          onChange={(v) => editBuffer(path, v ?? '')}
          saveViewState
          keepCurrentModel
          options={{
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
            minimap: { enabled: true, scale: 1, renderCharacters: false },
            smoothScrolling: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            padding: { top: 8 },
            automaticLayout: true,
            tabSize: 2,
            bracketPairColorization: { enabled: true },
          }}
          loading={<Loader2 className="size-5 animate-spin text-faint" />}
        />
      </div>
      {saving && (
        <div className="absolute bottom-3 right-4 flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[11px] text-muted shadow-soft">
          <Save className="size-3" /> Saving…
        </div>
      )}
    </div>
  );
}

function FileDiffView({ workspace, path }: { workspace: CodeWorkspace; path: string }) {
  const dark = useIsDark();
  const buffer = useCode((s) => s.buffers[path]);
  const head = useQuery({ queryKey: ['code-file-head', workspace.id, path], queryFn: () => codeApi.fileAt(workspace.id, path, 'HEAD'), staleTime: 5_000 });
  const current = useQuery({
    queryKey: codeKeys.file(workspace.id, path),
    queryFn: () => codeApi.file(workspace.id, path).catch(() => ({ path, content: '', size: 0, binary: false })),
    enabled: !buffer,
    staleTime: 0,
  });
  const modified = buffer?.content ?? current.data?.content ?? '';
  if (head.isLoading || (!buffer && current.isLoading)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-faint" />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-[11px] text-muted">
        <span className="font-mono">HEAD</span> ↔ <span className="font-mono">working tree{isDirty(buffer) ? ' (unsaved)' : ''}</span>
        {!head.data?.exists && <span className="rounded-full bg-mint-soft px-2 text-emerald-700">new file</span>}
      </div>
      <div className="min-h-0 flex-1">
        <DiffEditor
          original={head.data?.content ?? ''}
          modified={modified}
          language={languageFor(path)}
          theme={dark ? 'neuroflow-dark' : 'neuroflow-light'}
          beforeMount={defineThemes}
          options={{ readOnly: true, renderSideBySide: true, fontSize: 12.5, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false }}
          loading={<Loader2 className="size-5 animate-spin text-faint" />}
        />
      </div>
    </div>
  );
}

function EmptyEditor({ workspace }: { workspace: CodeWorkspace }) {
  const setCommandBarOpen = useCode((s) => s.setCommandBarOpen);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <FileCode2 className="size-10 text-faint" />
      <div>
        <div className="text-sm font-medium text-ink">{workspace.repository.fullName}</div>
        <div className="mt-1 text-xs text-muted">Open a file from the explorer, or ask the Code Agent on the right.</div>
      </div>
      <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-left text-xs text-muted">
        <kbd className="rounded bg-surface px-1.5 font-mono text-[11px] text-ink-soft">Ctrl K</kbd>
        <button className="text-left hover:text-ink" onClick={() => setCommandBarOpen(true)}>
          Go to file or run a command
        </button>
        <kbd className="rounded bg-surface px-1.5 font-mono text-[11px] text-ink-soft">Ctrl S</kbd>
        <span>Save the current file</span>
        <kbd className="rounded bg-surface px-1.5 font-mono text-[11px] text-ink-soft">Ctrl L</kbd>
        <span>Ask the Code Agent</span>
        <kbd className="rounded bg-surface px-1.5 font-mono text-[11px] text-ink-soft">Ctrl `</kbd>
        <span>Toggle the bottom panel</span>
      </div>
    </div>
  );
}
