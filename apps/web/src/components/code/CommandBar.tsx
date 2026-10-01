import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { File, Search, Sparkles, Terminal } from 'lucide-react';
import type { CodeWorkspace } from '@neuroflow/contracts';
import { cn } from '@/lib/utils';
import { useTree } from '@/hooks/code';
import { useCode } from '@/stores/code';
import { AGENT_ACTIONS, type AgentAction } from './EditorArea';

type Item = { id: string; label: string; hint?: string; icon: typeof File; run(): void };

/** Fuzzy subsequence score: lower is better, -1 = no match. */
function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return idx + (t.length - q.length) * 0.01;
  let pos = 0;
  let gaps = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, pos);
    if (next < 0) return -1;
    gaps += next - pos;
    pos = next + 1;
  }
  return 100 + gaps;
}

/**
 * Ctrl/Cmd+K: go to file, ask the agent, run project commands. `>` filters to commands;
 * `?` sends the rest of the input to the Code Agent.
 */
export function CommandBar({
  workspace,
  commands,
  onAsk,
  onAction,
  onRunCommand,
}: {
  workspace: CodeWorkspace;
  commands: Record<string, string>;
  onAsk(text: string): void;
  onAction(a: AgentAction): void;
  onRunCommand(command: string, kind: 'install' | 'test' | 'lint' | 'build'): void;
}) {
  const open = useCode((s) => s.commandBarOpen);
  const setOpen = useCode((s) => s.setCommandBarOpen);
  const openFile = useCode((s) => s.openFile);
  const tree = useTree(workspace.id, workspace.status);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  const items: Item[] = useMemo(() => {
    const close = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    if (query.startsWith('?')) {
      const text = query.slice(1).trim();
      return text ? [{ id: 'ask', label: `Ask the Code Agent: ${text}`, icon: Sparkles, run: close(() => onAsk(text)) }] : [];
    }
    const cmdMode = query.startsWith('>');
    const q = cmdMode ? query.slice(1).trim() : query.trim();
    const actionItems: Item[] = [
      ...AGENT_ACTIONS.map((a) => ({ id: `action-${a.id}`, label: `Agent: ${a.label}`, hint: 'active file / selection', icon: Sparkles, run: close(() => onAction(a.id)) })),
      ...(['test', 'lint', 'build', 'install'] as const)
        .filter((k) => commands[k])
        .map((k) => ({ id: `cmd-${k}`, label: `Run ${k}`, hint: commands[k], icon: Terminal, run: close(() => onRunCommand(commands[k]!, k)) })),
    ];
    const matchedActions = actionItems
      .map((i) => ({ i, s: score(q, i.label) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.i);
    if (cmdMode) return matchedActions;
    const files = (tree.data?.files ?? [])
      .map((f) => ({ f, s: score(q, f.path) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.f.path.length - b.f.path.length)
      .slice(0, 50)
      .map(({ f }) => ({ id: `file-${f.path}`, label: f.path, icon: File, run: close(() => openFile(f.path)) }));
    const ask: Item[] = q.length > 12 ? [{ id: 'ask', label: `Ask the Code Agent: ${q}`, icon: Sparkles, run: close(() => onAsk(q)) }] : [];
    return [...files.slice(0, q ? 30 : 12), ...(q ? matchedActions.slice(0, 6) : matchedActions), ...ask];
  }, [query, tree.data, commands, onAsk, onAction, onRunCommand, openFile, setOpen]);

  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/10 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className="glass-strong fixed left-1/2 top-[12vh] z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-2xl outline-none"
          aria-describedby={undefined}
          data-testid="command-bar"
        >
          <DialogPrimitive.Title className="sr-only">Command bar</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setIndex((i) => Math.min(i + 1, items.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  items[index]?.run();
                }
              }}
              placeholder="Go to file · > commands · ? ask the agent"
              className="h-11 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
              data-testid="command-input"
            />
          </div>
          <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5">
            {items.length === 0 && <div className="px-3 py-4 text-center text-xs text-faint">No matches</div>}
            {items.map((item, i) => (
              <button
                key={item.id}
                data-index={i}
                onMouseMove={() => setIndex(i)}
                onClick={item.run}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]', i === index ? 'bg-violet-soft text-ink' : 'text-ink-soft')}
              >
                <item.icon className={cn('size-3.5 shrink-0', item.icon === Sparkles ? 'text-accent' : 'text-faint')} />
                <span className={cn('min-w-0 flex-1 truncate', item.icon === File && 'font-mono text-[12px]')}>{item.label}</span>
                {item.hint && <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-faint">{item.hint}</span>}
              </button>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
