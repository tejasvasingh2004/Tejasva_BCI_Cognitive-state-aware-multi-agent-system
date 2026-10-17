import { useEffect, useState } from 'react';
import type { Check } from 'lucide-react';
import { CircleDashed, FileCode2, FlaskConical, GitBranch, GitPullRequest, ListChecks, Loader2, ShieldCheck, Sparkles, Terminal } from 'lucide-react';
import { cn } from './ui';

type Step = { icon: typeof Check; title: string; detail?: string };

/** The steps of a real Code Agent run (the same events the product shows in its Activity panel). */
const STEPS: Step[] = [
  { icon: FileCode2, title: 'Loaded acme/calc', detail: 'main · 4 files · JavaScript' },
  { icon: ListChecks, title: 'Created a plan', detail: '3 steps' },
  { icon: FileCode2, title: 'Read src/math.js', detail: 'lines 1–4' },
  { icon: Sparkles, title: 'Proposed a patch', detail: '1 file · +1 −1' },
  { icon: ShieldCheck, title: 'You approved the change', detail: 'Review mode' },
  { icon: FlaskConical, title: 'Tests passed (1/1)', detail: 'npm test · sandbox · 0.7s' },
  { icon: GitBranch, title: 'Committed on neuroflow/agent/fix-add', detail: 'main untouched' },
  { icon: GitPullRequest, title: 'Opened draft pull request #12', detail: 'ready for your review' },
];

const PLAN = ['Read src/math.js', 'Fix add()', 'Run the tests'];

export function AgentDemo() {
  // Server render and no-JS visitors see the finished run; the browser then replays it.
  const [step, setStep] = useState(STEPS.length);
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    let i = 0;
    setStep(0);
    const timer = setInterval(() => {
      i = i >= STEPS.length + 3 ? 0 : i + 1;
      setStep(Math.min(i, STEPS.length));
    }, 1400);
    return () => clearInterval(timer);
  }, []);

  const view = step < 3 ? 'code' : step < 5 ? 'diff' : step < 7 ? 'terminal' : 'pr';

  return (
    <div className="glass-strong overflow-hidden rounded-[26px] text-left" aria-label="A Code Agent run, step by step">
      <div className="flex h-11 items-center gap-2 border-b border-white/70 px-4">
        <span className="size-2.5 rounded-full bg-[#eea08b]" />
        <span className="size-2.5 rounded-full bg-[#efcf8e]" />
        <span className="size-2.5 rounded-full bg-[#a9cf9c]" />
        <span className="ml-3 truncate font-mono text-[11px] text-faint">acme/calc · main · Review mode</span>
      </div>
      <div className="grid md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        {/* Agent panel */}
        <div className="border-b border-white/70 p-4 md:border-b-0 md:border-r">
          <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3 py-2 text-[13px] text-canvas">Fix the failing add test</div>
          <div className="mt-4 space-y-2">
            {STEPS.map((s, i) => {
              const state = i < step ? 'done' : i === step ? 'active' : 'pending';
              if (state === 'pending') return null;
              const waiting = i === 4 && state === 'active';
              const Icon = s.icon;
              return (
                <div key={s.title} className="flex animate-fade-in items-start gap-2.5 text-[13px]">
                  <span className="mt-0.5 shrink-0">
                    {state === 'done' ? (
                      <Icon className={cn('size-3.5', i === 5 ? 'text-mint' : 'text-faint')} />
                    ) : waiting ? (
                      <CircleDashed className="size-3.5 text-amber" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin text-accent-soft" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className={cn(state === 'done' ? 'text-ink-soft' : 'text-ink')}>{waiting ? 'Waiting for your review' : s.title}</span>
                    {s.detail && <span className="block text-[11px] text-faint">{s.detail}</span>}
                    {i === 1 && state === 'done' && (
                      <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[11.5px] text-muted">
                        {PLAN.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ol>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {/* Artifact panel */}
        <div className="min-h-[270px] bg-white/45 p-4 font-mono text-[12px] leading-[20px]">
          <div key={view} className="animate-fade-up [animation-duration:350ms]">
              {view === 'code' && (
                <div>
                  <div className="mb-2 text-[11px] text-faint">src/math.js</div>
                  <Line n={1}>
                    <span className="text-accent-soft">export function</span> add(a, b) {'{'}
                  </Line>
                  <Line n={2}>
                    {'  '}
                    <span className="text-accent-soft">return</span> a - b;
                  </Line>
                  <Line n={3}>{'}'}</Line>
                  <div className="mt-4 text-[11px] text-rose">✕ add: expected 5, got -1</div>
                </div>
              )}
              {view === 'diff' && (
                <div>
                  <div className="mb-2 flex items-center justify-between text-[11px] text-faint">
                    <span>src/math.js</span>
                    <span>
                      <span className="text-mint">+1</span> <span className="text-rose">−1</span>
                    </span>
                  </div>
                  <Line n={1}>
                    <span className="text-accent-soft">export function</span> add(a, b) {'{'}
                  </Line>
                  <Line n={2} tone="del">
                    {'  '}return a - b;
                  </Line>
                  <Line n={2} tone="add">
                    {'  '}return a + b;
                  </Line>
                  <Line n={3}>{'}'}</Line>
                  <div className="mt-4 flex justify-end gap-2 font-sans">
                    <span className="rounded-full px-3 py-1 text-[11px] text-muted">Reject</span>
                    <span className={cn('rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white', step === 4 && 'animate-pulse')}>
                      {step > 4 ? '✓ Applied' : 'Apply'}
                    </span>
                  </div>
                </div>
              )}
              {view === 'terminal' && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] text-faint">
                    <Terminal className="size-3" /> sandbox · no network · no secrets
                  </div>
                  <div className="text-ink-soft">
                    <span className="text-accent-soft">$</span> npm test
                  </div>
                  <div className="text-muted">▶ add</div>
                  <div className="text-mint">✔ add (0.6ms)</div>
                  <div className="text-muted">ℹ tests 1 · pass 1 · fail 0</div>
                  {step >= 6 && <div className="mt-2 text-mint">Final check passed</div>}
                </div>
              )}
              {view === 'pr' && (
                <div className="font-sans">
                  <div className="glass rounded-xl p-3">
                    <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                      <GitPullRequest className="size-4 text-mint" /> Fix add() to add its arguments
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-faint">neuroflow/agent/fix-add → main · draft #12</div>
                    <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded-full bg-mint/15 px-2 py-0.5 text-mint">tests passed</span>
                      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-accent-soft">1 file · +1 −1</span>
                      <span className="rounded-full bg-raised px-2 py-0.5 text-muted">reviewed by you</span>
                    </div>
                  </div>
                  <p className="mt-3 text-[12px] text-muted">NeuroFlow never merges. Review and merge on GitHub.</p>
                </div>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Line({ n, tone, children }: { n: number; tone?: 'add' | 'del'; children: React.ReactNode }) {
  return (
    <div className={cn('flex whitespace-pre', tone === 'add' && 'bg-mint/10', tone === 'del' && 'bg-rose/10')}>
      <span className="w-6 shrink-0 select-none text-right text-faint">{n}</span>
      <span className={cn('w-4 shrink-0 select-none text-center', tone === 'add' ? 'text-mint' : tone === 'del' ? 'text-rose' : 'text-transparent')}>
        {tone === 'add' ? '+' : tone === 'del' ? '−' : ' '}
      </span>
      <span className="text-ink-soft">{children}</span>
    </div>
  );
}
