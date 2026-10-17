import type { Check } from 'lucide-react';

/** An endless strip of glass chips (the list is rendered twice for a seamless loop). */
export function Marquee({ items }: { items: Array<{ icon: typeof Check; text: string }> }) {
  return (
    <div className="marquee-wrap relative overflow-hidden py-2 [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
      <div className="marquee flex w-max gap-3">
        {[0, 1].map((copy) =>
          items.map((p) => (
            <div key={`${copy}-${p.text}`} className="glass flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm text-ink-soft" aria-hidden={copy === 1}>
              <p.icon className="size-4 shrink-0 text-accent" /> {p.text}
            </div>
          )),
        )}
      </div>
    </div>
  );
}
