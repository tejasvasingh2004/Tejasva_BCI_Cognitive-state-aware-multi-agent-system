import { Check } from 'lucide-react';
import { PLAN_LIMITS, type Plan } from '@neuroflow/contracts/plans';
import { APP_URL } from '../site';
import { Tilt } from './depth';
import { ButtonLink, cn } from './ui';

/** Plan presentation. Limits come from the same definitions the API enforces. */
export const PLAN_COPY: Record<Plan, { name: string; price: string; note: string; blurb: string; cta: string; featured?: boolean }> = {
  free: { name: 'Free', price: '$0', note: 'forever', blurb: 'Try the Code Agent on your own repositories.', cta: 'Start free' },
  pro: { name: 'Pro', price: 'Coming soon', note: 'per user / month', blurb: 'For developers who ship with an agent every day.', cta: 'Start free, upgrade later', featured: true },
  team: { name: 'Team', price: 'Coming soon', note: 'per user / month', blurb: 'Shared workspaces, higher limits and priority execution.', cta: 'Start free, upgrade later' },
  enterprise: { name: 'Enterprise', price: 'Custom', note: 'self-hosted or dedicated', blurb: 'Your infrastructure, your models, no daily token cap.', cta: 'Self-host today' },
};

export const fmtTokens = (n: number | null) => (n === null ? 'Unlimited' : n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);

export function planFeatures(plan: Plan): string[] {
  const l = PLAN_LIMITS[plan];
  return [
    `${fmtTokens(l.dailyTokens)} model tokens per day`,
    `${l.runsPerMinute} new agent runs per minute`,
    `${l.activeRunsPerWorkspace} active runs, ${l.runningPerWorkspace} executing at once`,
    'Code Agent, sandboxed tests, diff review',
    plan === 'free' ? 'Standard queue priority' : plan === 'pro' ? 'Higher queue priority' : 'Highest queue priority',
  ];
}

export function PlanCards({ plans = ['free', 'pro', 'team', 'enterprise'] }: { plans?: Plan[] }) {
  return (
    <div className={cn('grid gap-4', plans.length === 4 ? 'md:grid-cols-2 lg:grid-cols-4' : 'md:grid-cols-3')}>
      {plans.map((plan) => {
        const c = PLAN_COPY[plan];
        return (
          <Tilt
            key={plan}
            max={5}
            className={cn('glass flex flex-col rounded-[26px] p-6', c.featured && 'bg-gradient-to-b from-sky/45 to-white/50 outline-1 outline-accent/30 glow')}
          >
            <div className="flex items-center justify-between">
              <p className="text-[15px] font-semibold text-ink">{c.name}</p>
              {c.featured && <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-accent-soft">Most popular</span>}
            </div>
            <p className="mt-4 text-3xl font-bold tracking-tight text-ink">{c.price}</p>
            <p className="text-xs text-faint">{c.note}</p>
            <p className="mt-3 text-sm leading-6 text-muted">{c.blurb}</p>
            <ul className="mt-5 flex-1 space-y-2.5">
              {planFeatures(plan).map((f) => (
                <li key={f} className="flex gap-2 text-sm text-ink-soft">
                  <Check className="mt-0.5 size-4 shrink-0 text-accent-soft" /> {f}
                </li>
              ))}
            </ul>
            <ButtonLink
              {...(plan === 'enterprise' ? { to: '/download#self-host' } : { href: `${APP_URL}/code` })}
              variant={c.featured ? 'accent' : 'outline'}
              className="mt-6 w-full"
            >
              {c.cta}
            </ButtonLink>
          </Tilt>
        );
      })}
    </div>
  );
}
