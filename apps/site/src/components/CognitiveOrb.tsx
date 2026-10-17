import { useState } from 'react';
import { Brain } from 'lucide-react';
import { cn } from './ui';

const STATES = [
  {
    id: 'focused',
    label: 'Focused',
    rings: 3,
    size: 128,
    tone: 'sphere-sky',
    lines: ['Plan: 3 steps, each with the files it touches.', 'Patch src/math.js (+1 −1) with the reasoning summary.', 'Tests: 12 passed in the sandbox; output attached.'],
  },
  { id: 'busy', label: 'Busy', rings: 2, size: 104, tone: 'sphere-mist', lines: ['Fixed add(); 12 tests pass.', 'One change waiting for your review.'] },
  { id: 'overloaded', label: 'Overloaded', rings: 1, size: 82, tone: 'sphere-ice', lines: ['Done. Review one diff when you are ready.'] },
] as const;

/** Cognitive Mode, interactive: the same answer shaped for three levels of workload. */
export function CognitiveOrb() {
  const [i, setI] = useState(0);
  const s = STATES[i]!;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2">
        <Brain className="size-5 text-accent" />
        <h3 className="text-2xl font-bold tracking-tight">Cognitive Mode</h3>
        <span className="ml-auto rounded-full bg-white/60 px-2 py-0.5 text-[11px] text-muted">optional</span>
      </div>
      <p className="mt-3 text-[15px] leading-7 text-muted">
        NeuroFlow can adapt how it presents work to your current workload: full detail when you are focused, short and decisive when you are overloaded. Off unless you turn it on.
      </p>

      <div className="relative mt-6 flex h-56 items-center justify-center" style={{ perspective: '800px' }} aria-hidden>
        {[0, 1, 2].map((r) => (
          <div
            key={r}
            className={cn('absolute rounded-full border transition-all duration-700', r < s.rings ? 'border-accent/30 opacity-100' : 'border-transparent opacity-0')}
            style={{ width: 170 + r * 70, height: 170 + r * 70, transform: `rotateX(72deg) rotateZ(${r * 30}deg)` }}
          >
            <span className="sphere sphere-cobalt absolute -top-1.5 left-1/2 size-3" />
          </div>
        ))}
        <div className={cn('sphere float transition-all duration-700', s.tone)} style={{ width: s.size, height: s.size }} />
      </div>

      <div className="glass mx-auto -mt-2 flex w-fit gap-0.5 rounded-full p-1" role="tablist" aria-label="Workload">
        {STATES.map((st, k) => (
          <button
            key={st.id}
            role="tab"
            aria-selected={k === i}
            onClick={() => setI(k)}
            className={cn('rounded-full px-3.5 py-1.5 text-xs font-semibold transition', k === i ? 'bg-ink text-canvas shadow' : 'text-muted hover:text-ink')}
          >
            {st.label}
          </button>
        ))}
      </div>

      <div className="glass mt-5 min-h-[124px] rounded-2xl p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Agent reply · {s.label.toLowerCase()}</p>
        <div key={s.id} className="mt-2 space-y-1.5">
          {s.lines.map((l, k) => (
            <p key={l} className="animate-fade-up text-[13.5px] text-ink-soft [animation-duration:500ms]" style={{ animationDelay: `${k * 80}ms` }}>
              {l}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
