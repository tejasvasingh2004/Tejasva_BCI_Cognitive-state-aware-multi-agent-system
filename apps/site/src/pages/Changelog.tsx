import { PageHeader, Section, cn } from '../components/ui';
import entries from '../content/changelog.json';

type Entry = { date: string; items: Array<{ hash: string; type: string; scope: string | null; title: string }> };

const TONE: Record<string, string> = {
  Feature: 'bg-accent/15 text-accent-soft',
  Fix: 'bg-mint/15 text-mint',
  Performance: 'bg-amber/15 text-amber',
  Infrastructure: 'bg-raised text-ink-soft',
  Docs: 'bg-raised text-muted',
};

const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export function Changelog() {
  const list = entries as Entry[];
  return (
    <>
      <PageHeader eyebrow="Changelog" title="What’s new">
        Generated from the commit history, so it always matches what shipped.
      </PageHeader>
      <Section className="pt-10">
        <div className="mx-auto max-w-3xl">
          {list.length === 0 && <p className="text-center text-sm text-muted">No entries yet.</p>}
          <ol className="relative space-y-12 border-l border-line pl-8">
            {list.map((e) => (
              <li key={e.date} className="relative">
                <span className="absolute -left-[37px] top-1.5 size-2.5 rounded-full bg-accent ring-4 ring-canvas" />
                <time className="text-sm font-semibold text-ink" dateTime={e.date}>
                  {fmtDate(e.date)}
                </time>
                <ul className="mt-4 space-y-3">
                  {e.items.map((it) => (
                    <li key={it.hash} className="flex items-start gap-3">
                      <span className={cn('mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', TONE[it.type] ?? TONE.Docs)}>{it.type}</span>
                      <span className="text-[15px] leading-6 text-ink-soft">
                        {it.title.charAt(0).toUpperCase() + it.title.slice(1)}
                        {it.scope && <span className="ml-2 font-mono text-[11px] text-faint">{it.scope}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      </Section>
    </>
  );
}
