import { PLAN_LIMITS, type Plan } from '@neuroflow/contracts/plans';
import { Faq } from '../components/Faq';
import { fmtTokens, PLAN_COPY, PlanCards } from '../components/PlanCards';
import { PageHeader, Reveal, Section } from '../components/ui';

const PLANS: Plan[] = ['free', 'pro', 'team', 'enterprise'];

const ROWS: Array<{ label: string; value: (p: Plan) => string }> = [
  { label: 'Model tokens per day', value: (p) => fmtTokens(PLAN_LIMITS[p].dailyTokens) },
  { label: 'New agent runs per minute', value: (p) => String(PLAN_LIMITS[p].runsPerMinute) },
  { label: 'Active runs per workspace', value: (p) => String(PLAN_LIMITS[p].activeRunsPerWorkspace) },
  { label: 'Runs executing at once', value: (p) => String(PLAN_LIMITS[p].runningPerWorkspace) },
  { label: 'Sandbox commands per minute', value: (p) => String(PLAN_LIMITS[p].commandsPerMinute) },
  { label: 'API requests per minute', value: (p) => PLAN_LIMITS[p].requestsPerMinute.toLocaleString('en-US') },
  { label: 'Queue priority', value: (p) => (p === 'free' ? 'Standard' : p === 'pro' ? 'High' : 'Highest') },
];

export function Pricing() {
  return (
    <>
      <PageHeader eyebrow="Pricing" title="Simple plans, clear limits">
        Every plan includes the Code Agent, sandboxed test runs, diff review and Model Lab. Paid plans are coming soon — start free today.
      </PageHeader>
      <Section className="pt-10">
        <PlanCards plans={PLANS} />
      </Section>

      <Section className="pt-0">
        <Reveal>
          <h2 className="text-2xl font-bold tracking-tight">Compare limits</h2>
          <p className="mt-2 text-sm text-muted">These are the limits NeuroFlow enforces today; daily token quotas reset at midnight UTC.</p>
          <div className="mt-6 overflow-x-auto rounded-2xl border border-line">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-panel/80 text-ink">
                <tr>
                  <th className="px-5 py-3 font-semibold">Limit</th>
                  {PLANS.map((p) => (
                    <th key={p} className="px-5 py-3 font-semibold">
                      {PLAN_COPY[p].name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {ROWS.map((r) => (
                  <tr key={r.label} className="text-ink-soft">
                    <td className="px-5 py-3 text-muted">{r.label}</td>
                    {PLANS.map((p) => (
                      <td key={p} className="px-5 py-3 font-medium">
                        {r.value(p)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </Section>

      <Section className="pt-0">
        <h2 className="mb-6 text-2xl font-bold tracking-tight">Billing questions</h2>
        <Faq
          items={[
            { q: 'When will paid plans be available?', a: 'Soon. Until then every workspace starts on Free, and limits are raised for early users on request.' },
            { q: 'What counts towards the daily token quota?', a: 'Model tokens used by your runs (prompt and completion), measured from the provider’s own usage reports. The quota resets at midnight UTC.' },
            { q: 'What happens when I hit a limit?', a: 'NeuroFlow tells you which limit you reached and when to retry; nothing is lost. Runs already in progress continue.' },
            { q: 'Can I use my own model keys?', a: 'Self-hosted deployments always use your own keys. Bring-your-own-key for the hosted service is planned.' },
          ]}
        />
      </Section>
    </>
  );
}
