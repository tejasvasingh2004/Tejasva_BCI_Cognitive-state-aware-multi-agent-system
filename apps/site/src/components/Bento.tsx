import type { ReactNode } from 'react';
import type { Check } from 'lucide-react';
import { Eye, FileCode2, GitBranch, GitPullRequest, History, KeyRound, Layers, ListChecks, Lock, ShieldCheck, Terminal, Wrench } from 'lucide-react';
import { Ribbon, Sphere, Terrazzo, Tilt } from './depth';
import { cn, Reveal } from './ui';

type Vars = React.CSSProperties & Record<`--${string}`, string | number>;

/** Feature tiles: each one a small, live piece of the product rather than an icon and a paragraph. */
export function Bento() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Tile className="lg:col-span-2" icon={ListChecks} eyebrow="Plan Review" title="Approve, edit or revise the plan before any code is touched.">
        <PlanVisual />
      </Tile>
      <Tile icon={Eye} eyebrow="Approval modes" title="Suggest, Review, Auto or Restricted. You choose." delay={0.08}>
        <ModesVisual />
      </Tile>
      <Tile icon={Terminal} eyebrow="Sandbox" title="Tests run in an isolated container, and failures get fixed.">
        <SandboxVisual />
      </Tile>
      <Tile className="lg:col-span-2" icon={Layers} eyebrow="Model Gateway" title="Every model behind one gateway, with fallbacks, budgets and circuit breakers." delay={0.08}>
        <OrbitVisual />
      </Tile>
      <Tile icon={GitBranch} eyebrow="Git workflow" title="Its own branch, draft pull requests, never merges.">
        <BranchVisual />
      </Tile>
      <Tile icon={Wrench} eyebrow="27 tools" title="Every tool call validated, authorized and audited." delay={0.08}>
        <ToolsVisual />
      </Tile>
      <Tile icon={Lock} eyebrow="Credentials" title="Your GitHub token never reaches the model or the browser." delay={0.16}>
        <VaultVisual />
      </Tile>
    </div>
  );
}

function Tile({ icon: Icon, eyebrow, title, children, className, delay = 0 }: { icon: typeof Check; eyebrow: string; title: string; children: ReactNode; className?: string; delay?: number }) {
  return (
    <Reveal delay={delay} className={className}>
      <Tilt className="glass h-full overflow-hidden rounded-[28px]" max={5}>
        <div className="flex h-full flex-col">
          <div className="relative h-56 overflow-hidden">{children}</div>
          <div className="border-t border-white/70 p-6 pt-5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-soft">
              <Icon className="size-3.5" /> {eyebrow}
            </p>
            <h3 className="mt-2 text-[17px] font-semibold leading-snug tracking-tight text-ink">{title}</h3>
          </div>
        </div>
      </Tilt>
    </Reveal>
  );
}

function PlanVisual() {
  const steps = ['Read src/math.js and its test', 'Fix add() and keep it a one-liner', 'Run the tests', 'Summarise the change for the reviewer'];
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-frost/70 to-transparent px-6">
      <Ribbon variant="a" className="absolute -right-8 bottom-[-30px] w-80 opacity-80" />
      <Sphere size={34} tone="sky" className="float absolute left-[8%] top-[14%]" />
      <div className="glass relative w-full max-w-md rounded-2xl p-4 shadow-xl">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-ink">
          <ListChecks className="size-3.5 text-accent" /> Proposed plan
          <span className="ml-auto rounded-full bg-amber/12 px-2 py-0.5 text-[10px] font-medium text-amber">waiting for you</span>
        </div>
        <ol className="seq mt-3 space-y-1.5" style={{ '--cycle': '8s' } as Vars}>
          {steps.map((s, i) => (
            <li key={s} style={{ '--i': i } as Vars} className="flex items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-[12px] text-ink-soft">
              <span className="flex size-4 items-center justify-center rounded-full bg-raised text-[9px] font-semibold text-muted">{i + 1}</span>
              {s}
              {i === 1 && <span className="ml-auto h-3.5 w-px animate-caret bg-accent" />}
            </li>
          ))}
        </ol>
        <div className="mt-3 flex justify-end gap-1.5 text-[11px] font-semibold">
          <span className="rounded-full px-2.5 py-1 text-muted">Revise</span>
          <span className="rounded-full bg-ink px-3 py-1 text-canvas">Approve edited plan</span>
        </div>
      </div>
    </div>
  );
}

function ModesVisual() {
  const modes = [
    { name: 'Suggest', desc: 'shows changes, never writes' },
    { name: 'Review', desc: 'writes after you approve', on: true },
    { name: 'Auto', desc: 'small safe edits apply' },
    { name: 'Restricted', desc: 'read-only' },
  ];
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-2 px-6">
      {modes.map((m, i) => (
        <div
          key={m.name}
          className={cn('flex items-center gap-3 rounded-xl px-3 py-2 text-[12px] transition', m.on ? 'glass translate-x-2 shadow-lg' : 'bg-white/35')}
          style={{ transform: `perspective(600px) rotateY(${m.on ? 0 : -8}deg) translateZ(${m.on ? 20 : 0}px)`, marginLeft: i * 6 }}
        >
          <span className={cn('size-2 rounded-full', m.on ? 'bg-accent' : 'bg-faint/50')} />
          <span className={cn('font-semibold', m.on ? 'text-ink' : 'text-muted')}>{m.name}</span>
          <span className="truncate text-[11px] text-faint">{m.desc}</span>
          {m.on && <ShieldCheck className="ml-auto size-3.5 text-accent" />}
        </div>
      ))}
    </div>
  );
}

function SandboxVisual() {
  const lines = [
    { t: '$ npm test', c: 'text-ink-soft' },
    { t: '✕ add: expected 5, got -1', c: 'text-rose' },
    { t: 'agent: patch src/math.js', c: 'text-accent-soft' },
    { t: '$ npm test', c: 'text-ink-soft' },
    { t: '✔ add (0.6ms)', c: 'text-mint' },
    { t: 'tests 12 · pass 12 · fail 0', c: 'text-muted' },
  ];
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6">
      <div className="absolute inset-x-6 bottom-6 top-6 overflow-hidden rounded-2xl" style={{ transform: 'perspective(700px) rotateX(10deg)' }}>
        <Terrazzo className="absolute inset-0 size-full opacity-70" seed={21} />
      </div>
      <div className="glass relative w-full rounded-2xl p-3.5 font-mono text-[11.5px] leading-[19px]">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-faint">
          <Terminal className="size-3" /> sandbox · no network · 2 CPU · 2 GB
        </div>
        <div className="seq" style={{ '--cycle': '9s' } as Vars}>
          {lines.map((l, i) => (
            <div key={i} style={{ '--i': i } as Vars} className={l.c}>
              {l.t}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function OrbitVisual() {
  const models = ['groq · gpt-oss-120b', 'qwen3 · local', 'gpt-oss-20b', 'deployment/fast', 'openai-compatible'];
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-t from-frost/60 to-transparent" />
      {/* Chips travel an ellipse (a tilted orbit) and pass behind and in front of the gateway. */}
      <div className="relative h-[150px] w-[440px] max-w-full">
        <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 440 150" fill="none" aria-hidden>
          <ellipse cx="220" cy="75" rx="220" ry="62" stroke="#2f6bd8" strokeOpacity="0.28" />
          <ellipse cx="220" cy="75" rx="170" ry="44" stroke="#2f6bd8" strokeOpacity="0.18" strokeDasharray="4 6" />
        </svg>
        <div className="absolute left-1/2 top-1/2 z-[2] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
          <Sphere size={82} tone="cobalt" />
        </div>
        {models.map((m, i) => (
          <div key={m} className="orbit-chip absolute left-0 top-0" style={{ '--i': i } as Vars}>
            <div className="glass whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[10.5px] text-ink-soft">{m}</div>
          </div>
        ))}
      </div>
      <span className="glass absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] font-semibold text-ink">Model Gateway</span>
      <div className="absolute right-5 top-5 flex flex-col items-end gap-1.5 text-[10.5px]">
        <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 text-ink-soft">
          <span className="size-1.5 rounded-full bg-mint" /> circuit closed
        </span>
        <span className="glass rounded-full px-2.5 py-1 text-ink-soft">8,000 TPM budget · shared</span>
      </div>
    </div>
  );
}

function BranchVisual() {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6">
      <svg viewBox="0 0 300 160" className="w-full" fill="none" aria-hidden>
        <path d="M10 110 H290" stroke="#b3c6db" strokeWidth="3" strokeLinecap="round" />
        <path className="draw" style={{ '--len': 260 } as Vars} d="M70 110 C 100 110, 100 50, 140 50 H 230" stroke="#2f6bd8" strokeWidth="3" strokeLinecap="round" />
        {[40, 110, 260].map((x) => (
          <circle key={x} cx={x} cy={110} r="6" fill="#f8fbfe" stroke="#b3c6db" strokeWidth="3" />
        ))}
        {[150, 190].map((x) => (
          <circle key={x} cx={x} cy={50} r="6" fill="#f8fbfe" stroke="#2f6bd8" strokeWidth="3" />
        ))}
        <text x="14" y="134" className="fill-[#8a9bb0] font-mono text-[10px]">main</text>
        <text x="132" y="34" className="fill-[#2357bb] font-mono text-[10px]">neuroflow/agent/fix-add</text>
      </svg>
      <div className="glass absolute bottom-6 right-6 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-ink">
        <GitPullRequest className="size-3.5 text-mint" /> Draft PR #12
      </div>
    </div>
  );
}

function ToolsVisual() {
  const tools = ['read_file', 'search_code', 'find_symbol', 'apply_patch', 'run_tests', 'git_diff', 'commit', 'push', 'create_pull_request', 'search_memory', 'find_references', 'run_linter'];
  return (
    <div className="absolute inset-0 flex flex-wrap content-center justify-center gap-1.5 px-5" style={{ perspective: '700px' }}>
      {tools.map((t, i) => (
        <span
          key={t}
          className={cn('rounded-lg px-2 py-1 font-mono text-[10.5px]', i % 4 === 1 ? 'glass text-ink' : 'bg-white/45 text-muted')}
          style={{ transform: `translateZ(${(i % 3) * 14}px) rotateX(${(i % 2) * 6}deg)` }}
        >
          {t}
        </span>
      ))}
      <div className="mt-2 flex w-full items-center justify-center gap-1 text-[10px] text-faint">
        schema <span className="text-accent">→</span> authorize <span className="text-accent">→</span> approve <span className="text-accent">→</span> run
      </div>
    </div>
  );
}

function VaultVisual() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative size-40" style={{ transform: 'perspective(600px) rotateX(18deg) rotateY(-16deg)' }}>
        <div className="absolute inset-0 overflow-hidden rounded-[28px] shadow-2xl">
          <Terrazzo className="absolute inset-0 size-full" seed={42} base="#e3ebf5" />
        </div>
        <div className="glass absolute inset-4 flex flex-col items-center justify-center gap-2 rounded-[20px]">
          <KeyRound className="size-7 text-accent" />
          <span className="font-mono text-[10px] text-muted">AES-256-GCM</span>
        </div>
      </div>
      <div className="glass absolute left-5 top-6 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] text-ink-soft">
        <FileCode2 className="size-3 text-faint" /> model sees code, not tokens
      </div>
      <div className="glass absolute bottom-6 right-5 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] text-ink-soft">
        <History className="size-3 text-faint" /> every action audited
      </div>
    </div>
  );
}
