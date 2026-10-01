import type { ApprovalMode } from '@neuroflow/contracts';
import { Eye, Lock, ShieldCheck, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiRequestError } from '@/lib/api';

export const inputClass =
  'w-full rounded-xl border border-line bg-surface/80 px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-accent/50';

export const APPROVAL_MODES: Array<{ id: ApprovalMode; label: string; description: string; icon: typeof Eye }> = [
  { id: 'suggest', label: 'Suggest', description: 'The agent proposes patches; nothing is applied.', icon: Eye },
  { id: 'review', label: 'Review', description: 'Every patch waits for your approval before it is applied.', icon: ShieldCheck },
  { id: 'auto', label: 'Auto', description: 'Low-risk edits apply automatically; deletions, renames, large or sensitive changes still ask.', icon: Zap },
  { id: 'restricted', label: 'Restricted', description: 'Read-only: the agent can explore and explain but not change or run anything.', icon: Lock },
];

export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const tone =
    status === 'ready' || status === 'passed' || status === 'completed'
      ? 'bg-emerald-500'
      : status === 'error' || status === 'failed' || status === 'denied' || status === 'timeout'
        ? 'bg-rose-500'
        : status === 'cancelled'
          ? 'bg-faint'
          : 'bg-amber-400 animate-pulse';
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', tone, className)} />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = 'sm',
}: {
  value: T;
  options: Array<{ id: T; label: string; badge?: number | string; testId?: string }>;
  onChange(v: T): void;
  className?: string;
  size?: 'xs' | 'sm';
}) {
  return (
    <div className={cn('flex items-center gap-0.5 overflow-x-auto', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          data-testid={o.testId}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-full font-medium transition',
            size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
            value === o.id ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
          {o.badge !== undefined && o.badge !== 0 && (
            <span className="rounded-full bg-violet-soft px-1.5 text-[10px] font-semibold text-accent">{o.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
