import { ArrowRight, Brain, Download, Eye, FlaskConical, GitPullRequest, History, Layers, ListChecks, Lock, MessageSquare, Plug, ShieldCheck } from 'lucide-react';
import { AgentDemo } from '../components/AgentDemo';
import { Faq, type FaqItem } from '../components/Faq';
import { PlanCards } from '../components/PlanCards';
import { ButtonLink, Eyebrow, Reveal, Screenshot, Section } from '../components/ui';
import { Link } from '../router';
import { APP_URL } from '../site';

const PROOF = [
  { icon: ShieldCheck, text: 'Every change reviewed by you' },
  { icon: FlaskConical, text: 'Tests run in an isolated sandbox' },
  { icon: Lock, text: 'Credentials never reach the model' },
  { icon: Plug, text: 'Bring your own models' },
];

const FEATURES = [
  {
    icon: ListChecks,
    eyebrow: 'Plans first',
    title: 'It reads your repository and plans before it writes a line.',
    body: 'The Code Agent maps the project, finds the relevant files and symbols, and lays out a plan you can see and change before any code is touched. Your .neuroflow/instructions.md tells it how your team works.',
    image: '/screens/tests-pass.png',
    alt: 'Activity panel showing the agent loading the repository, planning, reading a file and passing tests',
  },
  {
    icon: Eye,
    eyebrow: 'You stay in control',
    title: 'Every change is a diff you approve.',
    body: 'Suggest, Review, Auto or Restricted: you choose how much the agent may do. In Review mode nothing is written until you click Apply. Deletes, renames and large or sensitive changes always ask.',
    image: '/screens/review.png',
    alt: 'A proposed change shown as a diff with Apply and Reject buttons',
  },
  {
    icon: FlaskConical,
    eyebrow: 'Proves it works',
    title: 'Tests run in a sandbox, and failures get fixed.',
    body: 'Commands run in an isolated container with no network (except installs), CPU and memory limits, and no secrets. When tests fail, the agent reads the output, repairs the code, and runs them again within a bounded budget.',
    image: '/screens/sandbox.png',
    alt: 'Terminal panel running the test suite inside the sandbox',
  },
  {
    icon: GitPullRequest,
    eyebrow: 'Ship safely',
    title: 'Commits on its own branch. Pull requests as drafts. Never merges.',
    body: 'Work lands on a neuroflow/agent/* branch, pushes need your approval, and pull requests open as drafts on GitHub. Replay shows exactly what happened in any run, from stored history, without running anything again.',
    image: '/screens/replay.png',
    alt: 'Replay of a recorded run with its patch, commands and evaluation signals',
  },
  {
    icon: Layers,
    eyebrow: 'Any model',
    title: 'One gateway, every model you choose.',
    body: 'Groq, Qwen locally through Ollama, and more behind one Model Gateway with routing, fallbacks, rate-limit budgets and circuit breakers. Model Lab lets you tune defaults, build datasets and compare models on your own tasks.',
    image: '/screens/model-lab.png',
    alt: 'Model Lab listing available models, tiers, context windows and pricing',
  },
];

const STEPS = [
  { n: '01', title: 'Connect GitHub', body: 'Use a fine-grained token or sign in with GitHub, then pick a repository and branch. Credentials stay encrypted on the server.' },
  { n: '02', title: 'Ask', body: 'Describe the change, or select code and ask the agent to explain, fix, refactor or write tests for it.' },
  { n: '03', title: 'Review and ship', body: 'Approve the diff, watch the tests pass in the sandbox, then commit, push and open a draft pull request.' },
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
      {/* Hero */}
      <div className="relative">
        <div className="grid-bg pointer-events-none absolute inset-0" />
        <div className="pointer-events-none absolute left-1/2 top-[-12rem] h-[34rem] w-[60rem] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />
        <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-32 sm:px-8 md:pt-40">
          <div className="mx-auto max-w-3xl animate-fade-up text-center">
            <Link to="/changelog" className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/70 px-3 py-1 text-xs text-ink-soft transition-colors hover:border-faint">
              <span className="size-1.5 rounded-full bg-mint" /> Code Agent, Model Lab and plan-based limits are live
              <ArrowRight className="size-3" />
            </Link>
            <h1 className="mt-6 text-[2.6rem] font-extrabold leading-[1.05] tracking-tight sm:text-6xl md:text-7xl">
              <span className="text-gradient">The AI workspace that plans, codes, and proves it works.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-7 text-muted sm:text-lg">
              NeuroFlow’s Code Agent reads your repository, proposes a plan, shows every change as a diff, and runs your tests in an isolated sandbox before anything is committed.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <ButtonLink href={`${APP_URL}/code`} size="lg">
                Open in browser <ArrowRight className="size-4" />
              </ButtonLink>
              <ButtonLink to="/download" variant="outline" size="lg">
                <Download className="size-4" /> Download
              </ButtonLink>
            </div>
          </div>
          <div className="mx-auto mt-16 max-w-5xl animate-fade-up [animation-delay:150ms]">
            <AgentDemo />
          </div>
        </div>
      </div>

      {/* Proof strip */}
      <div className="border-y border-line/70 bg-panel/40">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-5 py-7 sm:px-8 md:grid-cols-4">
          {PROOF.map((p) => (
            <div key={p.text} className="flex items-center gap-2.5 text-sm text-ink-soft">
              <p.icon className="size-4 shrink-0 text-accent-soft" /> {p.text}
            </div>
          ))}
        </div>
      </div>

      {/* Features */}
      <Section id="features">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>How NeuroFlow works</Eyebrow>
          <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-5xl">An agent you can actually trust with your code.</h2>
          <p className="mt-5 text-[17px] leading-7 text-muted">Understand, plan, change, verify, ship — with you approving every step that matters.</p>
        </Reveal>
        <div className="mt-20 space-y-28">
          {FEATURES.map((f, i) => (
            <div key={f.title} className="grid items-center gap-10 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:gap-14">
              <Reveal className={i % 2 ? 'md:order-2' : ''}>
                <div className="inline-flex size-10 items-center justify-center rounded-xl border border-line bg-raised">
                  <f.icon className="size-5 text-accent-soft" />
                </div>
                <Eyebrow className="mt-5">{f.eyebrow}</Eyebrow>
                <h3 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">{f.title}</h3>
                <p className="mt-4 text-[15.5px] leading-7 text-muted">{f.body}</p>
              </Reveal>
              <Reveal delay={0.1} className={i % 2 ? 'md:order-1' : ''}>
                <Screenshot src={f.image} alt={f.alt} />
              </Reveal>
            </div>
          ))}
        </div>
      </Section>

      {/* Cognitive Mode + one workspace */}
      <Section className="pt-0">
        <div className="grid gap-4 md:grid-cols-2">
          <Reveal className="relative overflow-hidden rounded-2xl border border-line bg-panel/60 p-8">
            <Brain className="size-6 text-accent-soft" />
            <h3 className="mt-5 text-2xl font-bold tracking-tight">Cognitive Mode</h3>
            <p className="mt-3 text-[15px] leading-7 text-muted">
              Optional and unique to NeuroFlow: the workspace adapts to your current workload, from full detail when you are focused to short, decisive answers when you are overloaded. Turn it on when you want it.
            </p>
            <div className="mt-6 space-y-2.5">
              {[
                ['Focused', 'Full detail, all steps visible', 'w-[92%]'],
                ['Busy', 'Key points, fewer notifications', 'w-[58%]'],
                ['Overloaded', 'One clear answer, no noise', 'w-[26%]'],
              ].map(([label, desc, w]) => (
                <div key={label}>
                  <div className="flex justify-between text-xs">
                    <span className="text-ink-soft">{label}</span>
                    <span className="text-faint">{desc}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-raised">
                    <div className={`h-full rounded-full bg-gradient-to-r from-accent to-accent-soft ${w}`} />
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal delay={0.1} className="overflow-hidden rounded-2xl border border-line bg-panel/60 p-8">
            <MessageSquare className="size-6 text-accent-soft" />
            <h3 className="mt-5 text-2xl font-bold tracking-tight">One workspace for chat and code</h3>
            <p className="mt-3 text-[15px] leading-7 text-muted">
              Research, analysis and writing in Chat; repositories in Code; models in Model Lab — all on the same runtime, with live progress from real backend events and a replayable history.
            </p>
            <img src="/screens/chat.png" alt="NeuroFlow chat workspace answering a question" width={1440} height={900} loading="lazy" className="mt-6 rounded-xl border border-line" />
          </Reveal>
        </div>
      </Section>

      {/* How it works */}
      <Section className="pt-0">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>Get started in minutes</Eyebrow>
          <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">Connect. Ask. Review and ship.</h2>
        </Reveal>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.08} className="rounded-2xl border border-line bg-panel/50 p-6">
              <p className="font-mono text-sm text-accent-soft">{s.n}</p>
              <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{s.body}</p>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Pricing teaser */}
      <Section className="pt-0">
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
      <Section className="pt-0">
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
      <Section className="pt-0">
        <Reveal className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-accent/20 via-panel to-panel px-8 py-16 text-center">
          <History className="mx-auto size-7 text-accent-soft" />
          <h2 className="mx-auto mt-5 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">Give the agent a task. Keep the final say.</h2>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href={`${APP_URL}/code`} size="lg">
              Open NeuroFlow <ArrowRight className="size-4" />
            </ButtonLink>
            <ButtonLink to="/docs" variant="outline" size="lg">
              Read the docs
            </ButtonLink>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
