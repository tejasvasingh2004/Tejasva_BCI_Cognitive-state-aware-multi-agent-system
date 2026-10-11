import { ArrowRight, Check, Cpu, Download, FlaskConical, GitPullRequest, ListChecks, PenLine, ShieldCheck } from 'lucide-react';
import { Link } from '../router';
import { APP_URL } from '../site';
import { Layer, Ribbon, Sphere, Stage, Terrazzo } from './depth';
import { ButtonLink } from './ui';

/**
 * Hero: a frosted glass card holding the message, surrounded by floating glass panels that show
 * real moments of a Code Agent run. Panels lean toward the pointer and drift apart on scroll.
 */
export function HeroScene() {
  return (
    <Stage className="relative isolate overflow-hidden pb-10 pt-24 md:min-h-[860px] md:pb-0 md:pt-28">
      {/* Room: light, grid floor */}
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
        <div className="absolute left-1/2 top-[-18rem] h-[42rem] w-[70rem] -translate-x-1/2 rounded-full bg-white/80 blur-[110px]" />
        <div className="absolute right-[-10rem] top-[8rem] h-[30rem] w-[30rem] rounded-full bg-peach/40 blur-[120px]" />
        <div className="absolute left-[-12rem] top-[22rem] h-[26rem] w-[26rem] rounded-full bg-blush/80 blur-[100px]" />
        <div className="floor absolute inset-x-[-30%] top-[58%] h-[70%]" />
      </div>

      {/* Back layer: behind the glass card (seen blurred through it) */}
      <div className="pointer-events-none absolute inset-0 -z-[5] hidden md:block" aria-hidden>
        <Layer className="left-[3%] top-[17%] lg:left-[6%]" depth={26} rotate={[10, 30, -9]} enter={0.15} duration={8}>
          <PlanPanel />
        </Layer>
        <Layer className="right-[3%] top-[12%] lg:right-[6%]" depth={34} rotate={[12, -30, 10]} enter={0.3} duration={9}>
          <TestsPanel />
        </Layer>
        <Layer className="left-[13%] top-[9%]" depth={60} duration={6}>
          <Sphere size={66} tone="peach" />
        </Layer>
        <Layer className="right-[31%] top-[7%]" depth={40} duration={7}>
          <Sphere size={24} tone="sand" />
        </Layer>
        <Layer className="left-[7%] top-[52%] lg:left-[9%]" depth={48} enter={0.6} duration={7}>
          <Chip>
            <span className="size-1.5 rounded-full bg-mint" /> groq · gpt-oss-120b
          </Chip>
        </Layer>
      </div>

      {/* The card */}
      <div className="relative mx-auto max-w-[47rem] px-4 sm:px-6">
        <div className="glass-strong animate-fade-up rounded-[34px] px-6 pb-10 pt-8 text-center sm:px-12 sm:pb-12 sm:pt-10">
          <Link
            to="/changelog"
            className="inline-flex items-center gap-2 rounded-full border border-white/80 bg-white/60 px-3 py-1 text-xs font-medium text-ink-soft shadow-sm transition hover:bg-white"
          >
            <span className="size-1.5 rounded-full bg-mint" /> Plan Review, Tasks and Workspace Settings are live
            <ArrowRight className="size-3" />
          </Link>
          <h1 className="mt-6 text-[2.5rem] font-extrabold leading-[1.04] tracking-[-0.035em] sm:text-6xl lg:text-[4rem]">
            <span className="text-gradient">The AI workspace that plans, codes, and proves it works.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-[16.5px] leading-7 text-muted sm:text-[17px]">
            NeuroFlow’s Code Agent reads your repository, proposes a plan, shows every change as a diff, and runs your tests in an isolated sandbox before anything is committed.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href={`${APP_URL}/code`} variant="accent" size="lg">
              Open in browser <ArrowRight className="size-4" />
            </ButtonLink>
            <ButtonLink to="/download" variant="outline" size="lg">
              <Download className="size-4" /> Download
            </ButtonLink>
          </div>
        </div>
      </div>

      {/* Front layer: in front of the card */}
      <div className="pointer-events-none absolute inset-0 z-10 hidden md:block" aria-hidden>
        <Layer className="bottom-[7%] left-[2%] lg:left-[5%]" depth={80} rotate={[46, 8, -22]} enter={0.45} duration={10}>
          <DiffSlab />
        </Layer>
        <Layer className="bottom-[6%] right-[1%] lg:right-[4%]" depth={95} rotate={[6, -26, -5]} enter={0.6} duration={9}>
          <PullRequestPanel />
        </Layer>
        <Layer className="bottom-[16%] right-[-70px]" depth={120} duration={11}>
          <Sphere size={190} tone="cream" />
        </Layer>
        <Layer className="bottom-[5%] left-[30%]" depth={100} duration={6}>
          <Sphere size={44} tone="copper" />
        </Layer>
        <Layer className="bottom-[9%] right-[27%]" depth={70} enter={0.8} duration={8}>
          <Chip>
            <ShieldCheck className="size-3 text-accent" /> Review mode
          </Chip>
        </Layer>
      </div>

      {/* Small screens: a lighter composition under the card */}
      <div className="pointer-events-none relative mx-auto mt-8 flex max-w-sm items-end justify-center gap-4 px-4 md:hidden" aria-hidden>
        <Sphere size={46} tone="peach" className="float" />
        <div className="w-60 rotate-[-4deg]">
          <TestsPanel />
        </div>
        <Sphere size={28} tone="copper" className="float" />
      </div>
    </Stage>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <div className="glass flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 font-mono text-[11px] text-ink-soft">{children}</div>;
}

function PlanPanel() {
  const steps = [
    { t: 'Read src/math.js', s: 'done' },
    { t: 'Fix add() and keep it a one-liner', s: 'edit' },
    { t: 'Run the tests', s: 'todo' },
  ] as const;
  return (
    <div className="glass sheen w-[290px] rounded-[24px] p-4">
      <Ribbon variant="b" className="absolute -bottom-16 -right-14 w-56 opacity-70" />
      <div className="relative flex items-center gap-2 text-[12px] font-semibold text-ink">
        <ListChecks className="size-3.5 text-accent" /> Plan
        <span className="ml-auto rounded-full bg-amber/12 px-2 py-0.5 text-[10px] font-medium text-amber">waiting for you</span>
      </div>
      <ol className="relative mt-3 space-y-2">
        {steps.map((s, i) => (
          <li key={s.t} className="flex items-center gap-2 rounded-xl bg-white/60 px-2.5 py-1.5 text-[11.5px] text-ink-soft">
            <span className="flex size-4 items-center justify-center rounded-full bg-raised text-[9px] font-semibold text-muted">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{s.t}</span>
            {s.s === 'done' && <Check className="size-3 text-mint" />}
            {s.s === 'edit' && <PenLine className="size-3 text-accent" />}
          </li>
        ))}
      </ol>
      <div className="relative mt-3 flex justify-end gap-1.5 text-[10.5px] font-semibold">
        <span className="rounded-full px-2.5 py-1 text-muted">Revise</span>
        <span className="rounded-full bg-ink px-2.5 py-1 text-canvas">Approve plan</span>
      </div>
    </div>
  );
}

function TestsPanel() {
  return (
    <div className="glass sheen w-full rounded-[24px] p-4 md:w-[280px]" style={{ '--delay': '-4s' } as React.CSSProperties}>
      <Ribbon variant="a" className="absolute -bottom-20 -left-12 w-60 opacity-60" />
      <div className="relative flex items-center gap-2 text-[12px] font-semibold text-ink">
        <FlaskConical className="size-3.5 text-mint" /> Sandbox
        <span className="ml-auto font-mono text-[10px] font-normal text-faint">0.7s</span>
      </div>
      <div className="relative mt-3 font-mono text-[11px] leading-5">
        <div className="text-ink-soft">
          <span className="text-accent">$</span> npm test
        </div>
        <div className="text-mint">✔ add (0.6ms)</div>
        <div className="text-muted">tests 12 · pass 12 · fail 0</div>
      </div>
      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-raised">
        <div className="h-full w-full rounded-full bg-gradient-to-r from-mint/70 to-mint" />
      </div>
      <div className="relative mt-2 flex items-center gap-1.5 text-[10px] text-faint">
        <Cpu className="size-3" /> no network · 2 CPU · no secrets
      </div>
    </div>
  );
}

function DiffSlab() {
  return (
    <div className="relative h-[200px] w-[330px] overflow-hidden rounded-[26px] shadow-[0_50px_80px_-30px_rgb(100_60_30/0.5),inset_0_1px_0_rgb(255_255_255/0.8)]">
      <Terrazzo className="absolute inset-0 size-full" seed={11} />
      <div className="glass absolute inset-x-5 top-5 rounded-2xl p-3 font-mono text-[11px] leading-5">
        <div className="mb-1 flex justify-between text-[10px] text-faint">
          <span>src/math.js</span>
          <span>
            <span className="text-mint">+1</span> <span className="text-rose">−1</span>
          </span>
        </div>
        <div className="rounded bg-rose/10 px-1.5 text-rose">− return a - b;</div>
        <div className="rounded bg-mint/10 px-1.5 text-mint">+ return a + b;</div>
      </div>
    </div>
  );
}

function PullRequestPanel() {
  return (
    <div className="glass w-[270px] overflow-hidden rounded-[26px]">
      <div className="relative h-28 overflow-hidden">
        <Terrazzo className="absolute inset-0 size-full" seed={3} base="#efe4d8" />
        <Ribbon variant="c" className="absolute -left-4 top-0 w-[115%]" />
      </div>
      <div className="p-4">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
          <GitPullRequest className="size-4 text-mint" /> Draft pull request #12
        </div>
        <div className="mt-1 truncate font-mono text-[10.5px] text-faint">neuroflow/agent/fix-add → main</div>
        <div className="mt-3 flex flex-wrap gap-1.5 text-[10.5px]">
          <span className="rounded-full bg-mint/12 px-2 py-0.5 text-mint">tests passed</span>
          <span className="rounded-full bg-accent/12 px-2 py-0.5 text-accent-soft">+1 −1</span>
          <span className="rounded-full bg-raised px-2 py-0.5 text-muted">reviewed by you</span>
        </div>
      </div>
    </div>
  );
}
