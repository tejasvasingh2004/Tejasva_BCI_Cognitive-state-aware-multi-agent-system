import { Link } from '../router';
import { Code, PageHeader, Section } from '../components/ui';
import { APP_URL } from '../site';

const SECTIONS = [
  { id: 'quickstart', title: 'Quickstart' },
  { id: 'github', title: 'Connect GitHub' },
  { id: 'approval-modes', title: 'Approval modes' },
  { id: 'instructions', title: 'Repository instructions' },
  { id: 'api', title: 'OpenAI-compatible API' },
  { id: 'self-host', title: 'Self-hosting' },
];

function H2({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="scroll-mt-24 text-2xl font-bold tracking-tight text-ink">
      {children}
    </h2>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="mt-3 text-[15px] leading-7 text-muted">{children}</p>;

export function Docs() {
  return (
    <>
      <PageHeader eyebrow="Docs" title="NeuroFlow documentation">
        Everything you need to use the Code Agent, connect your repositories and run NeuroFlow yourself.
      </PageHeader>
      <Section className="pt-10">
        <div className="grid gap-12 md:grid-cols-[200px_minmax(0,1fr)]">
          <nav className="md:sticky md:top-24 md:self-start" aria-label="Docs sections">
            <ul className="space-y-1.5 text-sm">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="text-muted transition-colors hover:text-ink">
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="max-w-3xl space-y-14">
            <section>
              <H2 id="quickstart">Quickstart</H2>
              <P>
                Open <a className="text-ink underline-offset-4 hover:underline" href={`${APP_URL}/code`}>NeuroFlow</a>, connect GitHub, pick a repository and
                branch, and choose an approval mode. NeuroFlow clones the branch into an isolated workspace. Then ask the Code Agent for a change — for example,
                “Fix the failing tests” — and review its plan, diffs and test results in the agent panel.
              </P>
            </section>
            <section>
              <H2 id="github">Connect GitHub</H2>
              <P>
                Use a fine-grained personal access token limited to the repositories you want, with <b className="text-ink-soft">Contents: Read and write</b>,{' '}
                <b className="text-ink-soft">Pull requests: Read and write</b> and <b className="text-ink-soft">Metadata: Read</b>. Read access alone is enough
                to explore and test; pushing and pull requests need write access. Tokens are encrypted on the server and never reach the model or the browser.
              </P>
            </section>
            <section>
              <H2 id="approval-modes">Approval modes</H2>
              <div className="mt-4 overflow-hidden rounded-xl border border-line">
                {[
                  ['Suggest', 'The agent proposes patches; nothing is applied.'],
                  ['Review', 'Every patch waits for your approval before it is applied.'],
                  ['Auto', 'Low-risk edits apply automatically; deletions, renames, large or sensitive changes still ask.'],
                  ['Restricted', 'Read-only: the agent can explore and explain, but not change or run anything.'],
                ].map(([name, desc]) => (
                  <div key={name} className="flex gap-4 border-b border-line px-4 py-3 text-sm last:border-0">
                    <span className="w-24 shrink-0 font-semibold text-ink">{name}</span>
                    <span className="text-muted">{desc}</span>
                  </div>
                ))}
              </div>
              <P>Pushes and pull requests always need your approval, commits land on a neuroflow/agent/* branch, and NeuroFlow never merges.</P>
            </section>
            <section>
              <H2 id="instructions">Repository instructions</H2>
              <P>
                Add a <code className="font-mono text-ink-soft">.neuroflow/instructions.md</code> file to your repository to tell the agent how your team works —
                conventions, commands, things to avoid. It is included in every Code Agent run for that repository.
              </P>
              <Code>{`# .neuroflow/instructions.md
- Use pnpm, never npm.
- Run "pnpm test --filter <package>" after changes.
- Prefer small functions; add tests for bug fixes.`}</Code>
            </section>
            <section>
              <H2 id="api">OpenAI-compatible API</H2>
              <P>
                NeuroFlow exposes <code className="font-mono text-ink-soft">POST /v1/chat/completions</code>, so existing OpenAI clients can use the same runtime
                (routing, agents, tools, memory and evaluation). Create an API key in Settings.
              </P>
              <Code>{`curl https://your-neuroflow-host/v1/chat/completions \\
  -H "Authorization: Bearer $NEUROFLOW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"Summarise event sourcing"}],"stream":true}'`}</Code>
              <P>
                Responses include standard <code className="font-mono text-ink-soft">RateLimit-Limit</code> and{' '}
                <code className="font-mono text-ink-soft">RateLimit-Remaining</code> headers; a 429 response carries{' '}
                <code className="font-mono text-ink-soft">Retry-After</code>.
              </P>
            </section>
            <section>
              <H2 id="self-host">Self-hosting</H2>
              <P>
                See <Link to="/download#self-host" className="text-ink underline-offset-4 hover:underline">Download → Self-host</Link> for the commands. Key
                settings in <code className="font-mono text-ink-soft">.env</code>:
              </P>
              <div className="mt-4 overflow-hidden rounded-xl border border-line font-mono text-[13px]">
                {[
                  ['GROQ_API_KEY / QWEN_BASE_URL', 'Model providers (at least one)'],
                  ['SESSION_SECRET, SECRETS_KEY', 'Required in production; SECRETS_KEY encrypts stored GitHub tokens'],
                  ['MODEL_PROVIDER_LIMITS', 'Provider budgets, e.g. groq:tpm=8000,rpm=30'],
                  ['WORKER_QUEUES, WORKER_*_CONCURRENCY', 'Which queues a worker serves and how many jobs at once'],
                  ['CODE_DATA_DIR', 'Where repository checkouts live (shared by API and worker)'],
                ].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-1 border-b border-line px-4 py-3 last:border-0 sm:flex-row sm:gap-4">
                    <span className="shrink-0 text-ink-soft sm:w-80">{k}</span>
                    <span className="font-sans text-muted">{v}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </Section>
    </>
  );
}
