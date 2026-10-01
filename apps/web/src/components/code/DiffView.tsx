import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react';
import { cn } from '@/lib/utils';

type DiffLine = { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; oldNo?: number; newNo?: number };
export type DiffFile = { path: string; oldPath?: string; status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary'; additions: number; deletions: number; lines: DiffLine[] };

/** Parses `git diff` unified output into files and numbered lines. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? line.slice(11), status: 'modified', additions: 0, deletions: 0, lines: [] };
      if (m && m[1] !== m[2]) cur.oldPath = m[1];
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      cur.status = 'renamed';
      cur.oldPath = line.slice(12);
    } else if (line.startsWith('Binary files')) cur.status = 'binary';
    else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      cur.lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('similarity ') || line.startsWith('rename to ')) {
      continue;
    } else if (line.startsWith('+')) {
      cur.additions++;
      cur.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      cur.deletions++;
      cur.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith(' ')) {
      cur.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith('\\')) {
      cur.lines.push({ kind: 'meta', text: line });
    }
  }
  return files;
}

const STATUS_LABEL: Record<DiffFile['status'], string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', binary: 'B' };
const STATUS_TONE: Record<DiffFile['status'], string> = {
  added: 'text-emerald-600 bg-mint-soft',
  deleted: 'text-rose-600 bg-rose-soft',
  modified: 'text-amber-600 bg-peach-soft',
  renamed: 'text-sky-600 bg-sky-soft',
  binary: 'text-muted bg-surface',
};

/** Read-only unified diff with per-file collapsing. Used for reviews, the Git panel and replay. */
export function DiffView({
  diff,
  onOpenFile,
  maxLines = 4000,
  className,
  emptyText = 'No changes',
}: {
  diff: string;
  onOpenFile?(path: string): void;
  maxLines?: number;
  className?: string;
  emptyText?: string;
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (!files.length) return <div className="px-4 py-6 text-center text-xs text-faint">{emptyText}</div>;
  let budget = maxLines;
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="diff-view">
      {files.map((f) => {
        const isCollapsed = collapsed[f.path];
        const lines = isCollapsed ? [] : f.lines.slice(0, Math.max(0, budget));
        budget -= lines.length;
        return (
          <div key={f.path} className="overflow-hidden rounded-xl border border-line bg-surface/70">
            <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-xs">
              <button onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))} className="text-faint hover:text-ink" aria-label="Toggle file">
                {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              </button>
              <span className={cn('rounded px-1 font-mono text-[10px] font-semibold', STATUS_TONE[f.status])}>{STATUS_LABEL[f.status]}</span>
              <button className="min-w-0 truncate text-left font-mono text-ink hover:underline" onClick={() => onOpenFile?.(f.path)} title={f.path}>
                {f.oldPath && f.status === 'renamed' ? `${f.oldPath} → ${f.path}` : f.path}
              </button>
              <span className="ml-auto shrink-0 font-mono text-[11px]">
                <span className="text-emerald-600">+{f.additions}</span> <span className="text-rose-500">−{f.deletions}</span>
              </span>
            </div>
            {!isCollapsed && (
              <div className="overflow-x-auto font-mono text-[11.5px] leading-[18px]">
                {f.status === 'binary' && <div className="px-3 py-2 text-faint">Binary file</div>}
                {lines.map((l, i) =>
                  l.kind === 'hunk' ? (
                    <div key={i} className="bg-violet-soft/60 px-3 text-[10.5px] text-accent">
                      {l.text}
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={cn(
                        'flex min-w-max',
                        l.kind === 'add' && 'bg-emerald-500/10',
                        l.kind === 'del' && 'bg-rose-500/10',
                        l.kind === 'meta' && 'text-faint',
                      )}
                    >
                      <span className="w-10 shrink-0 select-none pr-1 text-right text-faint">{l.oldNo ?? ''}</span>
                      <span className="w-10 shrink-0 select-none pr-1 text-right text-faint">{l.newNo ?? ''}</span>
                      <span className={cn('w-4 shrink-0 select-none text-center', l.kind === 'add' ? 'text-emerald-600' : l.kind === 'del' ? 'text-rose-500' : 'text-faint')}>
                        {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                      </span>
                      <span className="whitespace-pre pr-4 text-ink-soft">{l.text}</span>
                    </div>
                  ),
                )}
                {!isCollapsed && f.lines.length > lines.length && (
                  <div className="px-3 py-1.5 text-[11px] text-faint">… {f.lines.length - lines.length} more lines</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DiffStat({ files, className }: { files: Array<{ additions: number; deletions: number }>; className?: string }) {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-[11px]', className)}>
      <FileDiff className="size-3 text-faint" />
      {files.length} <span className="text-emerald-600">+{add}</span>
      <span className="text-rose-500">−{del}</span>
    </span>
  );
}
