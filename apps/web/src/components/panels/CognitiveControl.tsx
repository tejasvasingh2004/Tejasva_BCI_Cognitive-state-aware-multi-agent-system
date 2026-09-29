import { Activity, Brain } from 'lucide-react';
import type { WorkloadLevel } from '@neuroflow/contracts';
import { cn } from '@/lib/utils';
import { useCognitive, useSampleBci, useSetWorkload } from '@/hooks/queries';
import { useUi } from '@/stores/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const LEVELS: Array<{ id: WorkloadLevel; label: string; hint: string; dot: string }> = [
  { id: 'low', label: 'Focused, spare capacity', hint: 'detailed', dot: 'bg-emerald-400' },
  { id: 'medium', label: 'Moderately busy', hint: 'balanced', dot: 'bg-amber-400' },
  { id: 'high', label: 'Overloaded', hint: 'concise', dot: 'bg-rose-400' },
];

/**
 * Cognitive Mode control (explicit opt-in). The state is a policy signal only: it shapes
 * presentation and strategy, never permissions or tool safety.
 */
export function CognitiveControl() {
  const mode = useUi((s) => s.composer.mode);
  const setComposer = useUi((s) => s.setComposer);
  const enabled = mode === 'cognitive';
  const { data } = useCognitive(enabled);
  const setWorkload = useSetWorkload();
  const sample = useSampleBci();
  const current = LEVELS.find((l) => l.id === data?.state?.workload);

  if (!enabled) {
    return (
      <button
        onClick={() => setComposer({ mode: 'cognitive' })}
        className="glass-strong flex h-9 items-center gap-2 rounded-full px-3.5 text-xs text-ink-soft transition hover:text-ink"
        data-testid="cognitive-pill"
      >
        <Brain className="size-3.5 text-accent" /> Standard mode
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-9 items-center gap-2 rounded-full border border-violet-200 bg-violet-soft/90 px-3.5 text-xs font-medium text-accent-deep shadow-sm backdrop-blur" data-testid="cognitive-pill">
          <Brain className="size-3.5" />
          Cognitive
          <span className="flex items-center gap-1.5 rounded-full bg-white/80 px-2 py-0.5 text-[11px] text-ink-soft">
            <span className={cn('size-1.5 rounded-full', current?.dot ?? 'bg-faint')} />
            {current ? current.hint : 'no signal'}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>How loaded are you right now?</DropdownMenuLabel>
        {LEVELS.map((l) => (
          <DropdownMenuItem key={l.id} selected={data?.state?.workload === l.id} onSelect={() => setWorkload.mutate(l.id)} hint={l.hint}>
            <span className="flex items-center gap-2">
              <span className={cn('size-2 rounded-full', l.dot)} /> {l.label}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!data?.bciAvailable || sample.isPending} onSelect={() => sample.mutate()} hint={data?.bciAvailable ? 'EEG' : 'not configured'}>
          <span className="flex items-center gap-2">
            <Activity className="size-3.5 text-accent" /> Sample from BCI headset
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setComposer({ mode: 'standard' })}>Switch to Standard mode</DropdownMenuItem>
        {data?.state && (
          <p className="px-3 pb-2 pt-1 text-[11px] leading-4 text-faint">
            Source: {data.state.source} · confidence {Math.round(data.state.confidence * 100)}%. Affects presentation and strategy only — never
            permissions.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
