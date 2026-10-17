import { ArrowRight, Brain, Eye, FlaskConical, Gauge, GitBranch, GitPullRequest, History, ListChecks, Lock, MessageSquare, Plug, ShieldCheck } from 'lucide-react';
import { AgentDemo } from '../components/AgentDemo';
import { Bento } from '../components/Bento';
import { CognitiveOrb } from '../components/CognitiveOrb';
import { CountUp, Layer, Ribbon, Sphere, Stage, Terrazzo, Tilt } from '../components/depth';
import { Faq, type FaqItem } from '../components/Faq';
import { FeatureScroller, type ScrollFeature } from '../components/FeatureScroller';
import { HeroScene } from '../components/HeroScene';
import { Marquee } from '../components/Marquee';
import { PlanCards } from '../components/PlanCards';
import { ButtonLink, Eyebrow, Reveal, Section } from '../components/ui';
import { Link } from '../router';
import { APP_URL } from '../site';

const PROOF = [
  { icon: ShieldCheck, text: 'Every change reviewed by you' },
  { icon: FlaskConical, text: 'Tests run in an isolated sandbox' },
  { icon: Lock, text: 'Credentials never reach the model' },
  { icon: Plug, text: 'Bring your own models' },
  { icon: GitBranch, text: 'Agent branches and draft pull requests' },
  { icon: History, text: 'Replay from recorded history' },
  { icon: Gauge, text: 'Fair queues and plan-based limits' },
  { icon: Brain, text: 'Optional Cognitive Mode' },
];

const STORY: ScrollFeature[] = [
  {
    icon: ListChecks,
    eyebrow: 'Understand',
    title: 'It reads your repository and plans before it writes a line.',
    body: 'The Code Agent maps the project, finds the relevant files and symbols, and lays out a plan you can see and change. Your .neuroflow/instructions.md tells it how your team works.',
    points: ['Repository map, search, symbols and references', 'Your editor selection and pinned files as context', 'Never the whole repository in the prompt'],
    image: '/screens/tests-pass.png',
    alt: 'Activity panel showing the agent loading the repository, planning, reading a file and passing tests',
  },
  {
    icon: Eye,
    eyebrow: 'Review',
    title: 'Every change is a diff you approve.',
    body: 'In Review mode nothing is written until you click Apply. Deletes, renames and large or sensitive changes always ask, whatever the mode.',
    points: ['Patches validated before they are shown', 'Apply, reject or ask for another approach', 'The open editor follows the workspace live'],
    image: '/screens/review.png',
    alt: 'A proposed change shown as a diff with Apply and Reject buttons',
  },
  {
    icon: FlaskConical,
    eyebrow: 'Verify',
    title: 'Tests run in a sandbox, and failures get fixed.',
    body: 'Commands run in an isolated container with no network (except installs), CPU and memory limits, and no secrets. When tests fail, the agent reads the output and repairs the code within a bounded budget.',
    points: ['Docker sandbox with a read-only system', 'Bounded repair loop, never endless retries', 'Live output in the Terminal and Tests panels'],
    image: '/screens/sandbox.png',
    alt: 'Terminal panel running the test suite inside the sandbox',
  },
  {
    icon: GitPullRequest,
    eyebrow: 'Ship',
    title: 'Commit, push, open a draft PR. Replay any run later.',
    body: 'Work lands on a neuroflow/agent/* branch, pushes need your approval, and pull requests open as drafts. Replay shows exactly what happened, from stored history, without running anything again.',
    points: ['Your main branch is never touched', 'Pull requests are drafts; NeuroFlow never merges', 'Every event and artifact recorded'],
    image: '/screens/replay.png',
    alt: 'Replay of a recorded run with its patch, commands and evaluation signals',
  },
];

const STATS = [
  { value: 27, label: 'agent tools', note: 'each validated, authorized and approved' },
  { value: 6, label: 'execution strategies', note: 'the smallest reliable one is chosen' },
  { value: 4, label: 'approval modes', note: 'from read-only to auto' },
  { value: 0, label: 'secrets sent to the model', note: 'credentials stay on the server' },
];

const STEPS = [
  { n: '1', title: 'Connect GitHub', body: 'Use a fine-grained token or sign in with GitHub, then pick a repository and branch. Credentials stay encrypted on the server.' },
  { n: '2', title: 'Ask', body: 'Describe the change, or select code and ask the agent to explain, fix, refactor or write tests for it.' },
  { n: '3', title: 'Review and ship', body: 'Approve the diff, watch the tests pass in the sandbox, then commit, push and open a draft pull request.' },
];

const FAQ: FaqItem[] = [
  {
    q: 'Is my whole repository sent to the model?',
    a: 'No. The agent works with a repository map, the files it decides to read, your editor selection and pinned files, all within a bounded context budget. Your GitHub credentials are encrypted on the server and never reach the model or the browser.',
  },
  {
    q: 'Can the agent push to main or merge my pull requests?',
    a: 'No. It commits on its own neuroflow/agent/* branch, pushes only with your approval, opens pull requests as drafts, and never merges. Your main branch is never touched.',
  },
  {
    q: 'Where does the agent run my code?',
    a: 'In an isolated container: no network except dependency installs, CPU, memory and process limits, a read-only system, and no access to your secrets. It never runs commands on the API server.',
  },
  {
    q: 'Which models can I use?',
    a: 'Groq-hosted models (such as GPT-OSS 120B), Qwen locally through Ollama, and other OpenAI-compatible endpoints. NeuroFlow also exposes an OpenAI-compatible API, so your own tools can use the same runtime.',
  },
  {
    q: 'Can I self-host it?',
    a: 'Yes. NeuroFlow runs with Docker Compose (PostgreSQL, Redis, API, worker and web app) with your own model keys. See Download → Self-host.',
  },
  {
    q: 'What is Cognitive Mode?',
    a: 'An optional mode that adapts how NeuroFlow presents work to your current workload, from full detail when you are focused to concise answers when you are overloaded. It is off unless you turn it on.',
  },
];

export function Home() {
  return (
    <>
      <HeroScene />

      {/* Proof strip */}
      <div className="mx-auto max-w-6xl px-2 sm:px-6">
        <Marquee items={PROOF} />
      </div>

      {/* Watch a run */}
      <Section className="pb-10 md:pb-16">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>Watch a real run</Eyebrow>
          <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-5xl">From a sentence to a reviewed pull request.</h2>
          <p className="mt-5 text-[17px] leading-7 text-muted">Every step below is an event the product emits during a run: plan, read, patch, your approval, tests, commit and pull request.</p>
        </Reveal>
        <Stage scroll="enter" className="relative mx-auto mt-14 max-w-5xl">
          <div className="pointer-events-none absolute inset-0 hidden md:block" aria-hidden>
            <Layer className="-left-14 top-10" depth={40} duration={7}>
              <Sphere size={70} tone="sky" />
            </Layer>
            <Layer className="-right-16 bottom-14 z-20" depth={70} duration={9}>
              <Sphere size={130} tone="ice" />
            </Layer>
            <Layer className="-left-24 bottom-0 z-20" depth={60} rotate={[50, 0, -18]} duration={10}>
              <div className="relative h-28 w-44 overflow-hidden rounded-[22px] shadow-2xl">
                <Terrazzo className="absolute inset-0 size-full" seed={5} />
              </div>
            </Layer>
          </div>
          <div className="screen3d relative">
            <AgentDemo />
          </div>
          <div className="mx-auto mt-6 h-8 w-3/4 rounded-[50%] bg-[#25456f]/15 blur-2xl" aria-hidden />
        </Stage>
      </Section>

      {/* Bento */}
      <Section id="features" className="pt-10 md:pt-16">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>Built to be trusted</Eyebrow>
          <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-5xl">An agent you can actually trust with your code.</h2>
          <p className="mt-5 text-[17px] leading-7 text-muted">Every capability is bounded, reviewable and recorded, on one runtime shared by chat and code.</p>
        </Reveal>
        <div className="mt-14">
          <Bento />
        </div>
      </Section>

      {/* Scroll story */}
      <Section id="how" className="pt-0 md:pt-0">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>How NeuroFlow works</Eyebrow>
          <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-5xl">Understand. Review. Verify. Ship.</h2>
        </Reveal>
        <div className="mt-8 md:mt-0">
          <FeatureScroller items={STORY} />
        </div>
      </Section>

      {/* Numbers */}
      <Section className="pt-0 md:pt-0">
        <div className="glass relative overflow-hidden rounded-[32px] px-6 py-10 sm:px-10">
          <Ribbon variant="b" className="absolute -bottom-24 -right-24 w-[26rem] opacity-40" />
          <div className="relative grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STATS.map((s) => (
              <Reveal key={s.label}>
                <p className="text-gradient text-5xl font-extrabold tracking-tight sm:text-6xl">
                  <CountUp value={s.value} />
                </p>
                <p className="mt-2 text-sm font-semibold text-ink">{s.label}</p>
                <p className="mt-1 text-[13px] text-muted">{s.note}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </Section>

      {/* Cognitive Mode + one workspace */}
      <Section className="pt-0 md:pt-0">
        <div className="grid gap-4 md:grid-cols-2">
          <Reveal>
            <div className="glass h-full rounded-[28px] p-7 sm:p-8">
              <CognitiveOrb />
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="glass relative h-full rounded-[28px] p-7 sm:p-8">
              <MessageSquare className="size-5 text-accent" />
              <h3 className="mt-4 text-2xl font-bold tracking-tight">One workspace for chat and code</h3>
              <p className="mt-3 text-[15px] leading-7 text-muted">
                Research, analysis and writing in Chat; repositories in Code; models in Model Lab. All on the same runtime, with live progress from real backend events and a replayable history.
              </p>
              <div className="relative mt-10" style={{ perspective: '1200px' }}>
                <Sphere size={52} tone="cobalt" className="float absolute -right-3 -top-7 z-10" />
                <Sphere size={30} tone="sky" className="float absolute -bottom-4 -left-3 z-10" />
                <Tilt className="rounded-[18px]" max={8}>
                  <img
                    src="/screens/chat.png"
                    alt="NeuroFlow chat workspace answering a question"
                    width={1440}
                    height={900}
                    loading="lazy"
                    className="rounded-[18px] shadow-[0_40px_80px_-30px_rgb(25_60_125/0.55)]"
                    style={{ transform: 'rotateY(-10deg) rotateX(6deg)' }}
                  />
                </Tilt>
              </div>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* Get started */}
      <Section className="pt-0 md:pt-0">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>Get started in minutes</Eyebrow>
          <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">Connect. Ask. Review and ship.</h2>
        </Reveal>
        <div className="relative mt-14 grid gap-5 md:grid-cols-3">
          <svg className="pointer-events-none absolute left-[16%] top-8 hidden h-6 w-[68%] md:block" viewBox="0 0 600 24" preserveAspectRatio="none" fill="none" aria-hidden>
            <path d="M0 12 C 150 -6, 450 30, 600 12" stroke="#2f6bd8" strokeOpacity="0.35" strokeWidth="2" strokeDasharray="6 8" />
          </svg>
          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.08}>
              <Tilt className="glass h-full rounded-[26px] p-6" max={8}>
                <span className="sphere sphere-cobalt relative flex size-12 items-center justify-center text-lg font-bold text-white [text-shadow:0_1px_2px_rgb(15_40_100/0.5)]">{s.n}</span>
                <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{s.body}</p>
              </Tilt>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Pricing teaser */}
      <Section className="pt-0 md:pt-0">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">Start free. Scale when you need to.</h2>
        </Reveal>
        <div className="mt-12">
          <PlanCards plans={['free', 'pro', 'team']} />
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          Self-hosting and dedicated deployments: see{' '}
          <Link to="/pricing" className="text-ink underline-offset-4 hover:underline">
            all plans
          </Link>
          .
        </p>
      </Section>

      {/* FAQ */}
      <Section className="pt-0 md:pt-0">
        <div className="grid gap-10 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
          <div>
            <Eyebrow>FAQ</Eyebrow>
            <h2 className="mt-4 text-3xl font-bold tracking-tight">Questions, answered.</h2>
            <p className="mt-4 text-sm leading-6 text-muted">
              More in the{' '}
              <Link to="/docs" className="text-ink underline-offset-4 hover:underline">
                docs
              </Link>
              .
            </p>
          </div>
          <Faq items={FAQ} />
        </div>
      </Section>

      {/* Final CTA */}
      <Section className="pt-0 md:pt-0">
        <Stage scroll="enter" className="relative">
          <div className="pointer-events-none absolute inset-0 hidden md:block" aria-hidden>
            <Layer className="-left-6 -top-10 z-10" depth={40} duration={7}>
              <Sphere size={84} tone="sky" />
            </Layer>
            <Layer className="-bottom-10 right-16 z-10" depth={60} duration={8}>
              <Sphere size={60} tone="cobalt" />
            </Layer>
            <Layer className="-right-10 -top-8 z-10" depth={50} rotate={[20, -30, 12]} duration={9}>
              <div className="relative h-32 w-48 overflow-hidden rounded-[22px] shadow-2xl">
                <Terrazzo className="absolute inset-0 size-full" seed={9} />
              </div>
            </Layer>
          </div>
          <div className="glass-strong relative overflow-hidden rounded-[36px] px-8 py-16 text-center sm:py-20">
            <Ribbon variant="a" className="absolute -bottom-28 -left-28 w-[30rem] opacity-60" />
            <Ribbon variant="c" className="absolute -right-32 -top-24 w-[26rem] opacity-45" />
            <h2 className="relative mx-auto max-w-2xl text-3xl font-bold tracking-tight sm:text-5xl">
              <span className="text-gradient">Give the agent a task. Keep the final say.</span>
            </h2>
            <p className="relative mx-auto mt-5 max-w-lg text-[16px] leading-7 text-muted">Free to start. Your repositories, your models, your approval on every change that matters.</p>
            <div className="relative mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <ButtonLink href={`${APP_URL}/code`} variant="accent" size="lg">
                Open NeuroFlow <ArrowRight className="size-4" />
              </ButtonLink>
              <ButtonLink to="/docs" variant="outline" size="lg">
                Read the docs
              </ButtonLink>
            </div>
          </div>
        </Stage>
      </Section>
    </>
  );
}
