import { forwardRef } from 'react';
import { motion } from 'framer-motion';
import {
  BookOpenText,
  Brain,
  Calculator,
  Code2,
  GitCompareArrows,
  History,
  ListChecks,
  Mail,
  Rocket,
  Scale,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sparkle } from '@/components/ui/sparkle';
import { Composer, type ComposerHandle } from './Composer';

const CHIPS = [
  { icon: History, label: 'Recall a decision', prompt: 'What did I decide about pricing?', tone: 'text-orange-500' },
  { icon: Scale, label: 'Weigh a trade-off', prompt: 'Compare PostgreSQL and MongoDB for an event-sourced app — pros, cons and a recommendation.', tone: 'text-emerald-500' },
  { icon: ListChecks, label: 'Plan step by step', prompt: 'Give me a step-by-step plan to launch a small SaaS in 30 days.', tone: 'text-sky-500' },
  { icon: Brain, label: 'Explain simply', prompt: 'Explain how a brain-computer interface works, simply.', tone: 'text-rose-500' },
];

const TILES = [
  { icon: BookOpenText, label: 'Summarize & explain', prompt: 'Explain the key ideas of transformers in machine learning.' },
  { icon: GitCompareArrows, label: 'Compare options', prompt: 'Compare REST, GraphQL and gRPC for a mobile backend.' },
  { icon: Code2, label: 'Review code', prompt: 'Review this TypeScript function for bugs:\n\n```ts\nfunction avg(xs: number[]) { return xs.reduce((a, b) => a + b) / xs.length }\n```' },
  { icon: Calculator, label: 'Calculate precisely', prompt: 'Calculate (1299 * 12) * 0.82 and explain the result as an annual price with an 18% discount.' },
  { icon: Mail, label: 'Draft a message', prompt: 'Draft a short, friendly email asking my team for feedback on the new onboarding flow.' },
  { icon: Rocket, label: 'Plan a project', prompt: 'Give me a comprehensive, in-depth launch plan:\n1. positioning\n2. pricing\n3. channels\n4. risks' },
  { icon: History, label: 'Use my memory', prompt: 'What did I previously decide about our deployment region?' },
  { icon: Brain, label: 'Adapt to my focus', prompt: 'I am overloaded — give me the three most important things about Kubernetes, briefly.' },
];

type Props = { running: boolean; onSubmit(text: string): void; onStop(): void; name?: string };

export const Hero = forwardRef<ComposerHandle, Props>(function Hero({ running, onSubmit, onStop, name }, composerRef) {
  const fill = (prompt: string) => (composerRef && 'current' in composerRef ? composerRef.current?.setText(prompt) : undefined);

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-12">
      {/* soft pink light pool behind the greeting (reference: Aria screen) */}
      <div aria-hidden className="pointer-events-none absolute bottom-0 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(236,196,240,0.55),transparent)] blur-2xl" />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="relative flex w-full max-w-2xl flex-col items-center text-center"
      >
        <Sparkle className="mb-5 size-9 drop-shadow-[0_6px_14px_rgba(139,92,246,0.35)]" />
        <h1 className="text-[34px] font-semibold tracking-tight text-ink/90">
          Hey{name ? `, ${name}` : ''}, I&apos;m <span className="text-gradient">NeuroFlow</span>
        </h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted">
          Ask anything. I&apos;ll pick the right models and agents, use your memory and tools when they help, and show you
          exactly what happened.
        </p>

        <div className="mt-8 w-full">
          <Composer ref={composerRef} running={running} onSubmit={onSubmit} onStop={onStop} variant="hero" placeholder="Ask NeuroFlow anything about your work…" />
        </div>

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {CHIPS.map((c) => (
            <button
              key={c.label}
              onClick={() => fill(c.prompt)}
              className="flex items-center gap-2 rounded-full border border-surface/90 bg-surface/65 px-3.5 py-1.5 text-xs text-ink-soft shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:bg-surface hover:shadow-soft"
            >
              <c.icon className={cn('size-3.5', c.tone)} />
              {c.label}
            </button>
          ))}
        </div>
      </motion.div>

      <motion.section
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
        className="glass relative mt-14 w-full max-w-3xl rounded-[26px] p-5"
        aria-label="Start from a task"
      >
        <div className="mb-3 px-1 text-sm font-medium text-muted">What can I do for you?</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {TILES.map((t) => (
            <button
              key={t.label}
              onClick={() => fill(t.prompt)}
              className="group flex h-[88px] flex-col justify-between rounded-2xl border border-surface/80 bg-surface/55 p-3.5 text-left transition hover:-translate-y-0.5 hover:bg-surface hover:shadow-float"
            >
              <t.icon className="size-4 text-faint transition group-hover:text-accent" />
              <span className="text-[13px] text-ink-soft group-hover:text-ink">{t.label}</span>
            </button>
          ))}
        </div>
      </motion.section>
    </div>
  );
});
