import { ArrowRight, Apple, Globe, Monitor, Server, Terminal } from 'lucide-react';
import { ButtonLink, Code, PageHeader, Reveal, Section } from '../components/ui';
import { APP_URL, REPO_URL } from '../site';

const DESKTOP = [
  { icon: Monitor, name: 'Windows', note: 'Windows 10 and 11' },
  { icon: Apple, name: 'macOS', note: 'Apple silicon and Intel' },
  { icon: Terminal, name: 'Linux', note: 'AppImage and .deb' },
];

export function Download() {
  return (
    <>
      <PageHeader eyebrow="Download" title="Get NeuroFlow">
        Use it in the browser today, or run the whole platform on your own infrastructure. The desktop app is in development.
      </PageHeader>

      <Section className="pt-10 md:pt-10">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <Reveal className="flex flex-col glass rounded-[28px] bg-gradient-to-b from-peach/45 to-white/50 p-8 glow">
            <Globe className="size-6 text-accent-soft" />
            <div className="mt-5 flex items-center gap-2">
              <h2 className="text-2xl font-bold">Web app</h2>
              <span className="rounded-full bg-mint/15 px-2 py-0.5 text-[11px] font-medium text-mint">Available now</span>
            </div>
            <p className="mt-3 flex-1 text-[15px] leading-7 text-muted">
              Everything in one place: chat, the Code Agent with Monaco, terminal and diff review, and Model Lab. Nothing to install.
            </p>
            <ButtonLink href={`${APP_URL}/code`} variant="accent" size="lg" className="mt-8 self-start">
              Open in browser <ArrowRight className="size-4" />
            </ButtonLink>
          </Reveal>

          <Reveal delay={0.08} className="glass rounded-[28px] p-8">
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold">Desktop app</h2>
              <span className="rounded-full bg-amber/15 px-2 py-0.5 text-[11px] font-medium text-amber">In development</span>
            </div>
            <p className="mt-3 text-[15px] leading-7 text-muted">
              Open local folders without GitHub, run commands on your machine in a sandbox, native notifications and automatic updates.
            </p>
            <div className="mt-6 space-y-2">
              {DESKTOP.map((d) => (
                <div key={d.name} className="flex items-center gap-3 rounded-xl border border-white/70 bg-white/50 px-4 py-3">
                  <d.icon className="size-4 text-muted" />
                  <span className="text-sm font-medium text-ink-soft">{d.name}</span>
                  <span className="text-xs text-faint">{d.note}</span>
                  <span className="ml-auto text-xs text-faint">Coming soon</span>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </Section>

      <Section id="self-host" className="pt-0 md:pt-0">
        <Reveal className="glass rounded-[28px] p-8">
          <Server className="size-6 text-accent-soft" />
          <h2 className="mt-5 text-2xl font-bold">Self-host</h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted">
            Run NeuroFlow on your own servers with Docker: PostgreSQL, Redis, the API, the worker (with the sandbox) and the web app, using your own model keys.
          </p>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">Development</p>
              <Code>{`git clone ${REPO_URL}.git neuroflow
cd neuroflow
corepack enable && pnpm install
cp .env.example .env      # add GROQ_API_KEY or run Ollama
pnpm infra:up             # PostgreSQL + Redis
pnpm dev                  # API :8080 · worker · web :5173`}</Code>
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">Containers</p>
              <Code>{`cp .env.example .env
# set SESSION_SECRET, SECRETS_KEY, POSTGRES_PASSWORD
# and CODE_DATA_HOST_DIR (shared checkout path)
docker compose --profile app up -d --build
# create the first account
pnpm --filter @neuroflow/db cli create-user \\
  --email you@company.com --name "You"`}</Code>
            </div>
          </div>
          <p className="mt-5 text-sm text-muted">
            Requirements: Node 22+, Docker, and at least one model provider (Groq API key or local Ollama).
          </p>
        </Reveal>
      </Section>
    </>
  );
}
