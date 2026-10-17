import { Link } from '../router';
import { APP_URL, REPO_URL } from '../site';
import { Logo } from './ui';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Features', to: '/#features' },
      { label: 'Pricing', to: '/pricing' },
      { label: 'Download', to: '/download' },
      { label: 'Changelog', to: '/changelog' },
    ],
  },
  {
    title: 'Use it',
    links: [
      { label: 'Open in browser', href: `${APP_URL}/code` },
      { label: 'Docs', to: '/docs' },
      { label: 'Self-host', to: '/download#self-host' },
      { label: 'Source on GitHub', href: REPO_URL },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative mt-10 overflow-hidden border-t border-white/70 bg-gradient-to-b from-white/40 to-frost/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="text-[15px] font-bold text-ink">NeuroFlow</span>
          </div>
          <p className="mt-4 max-w-xs text-sm leading-6 text-muted">
            An AI workspace that plans, codes and proves it works, with every change reviewed by you.
          </p>
        </div>
        {COLUMNS.map((c) => (
          <div key={c.title}>
            <p className="text-sm font-semibold text-ink">{c.title}</p>
            <ul className="mt-4 space-y-2.5">
              {c.links.map((l) => (
                <li key={l.label}>
                  {'to' in l && l.to ? (
                    <Link to={l.to} className="text-sm text-muted transition-colors hover:text-ink">
                      {l.label}
                    </Link>
                  ) : (
                    <a href={'href' in l ? l.href : undefined} className="text-sm text-muted transition-colors hover:text-ink">
                      {l.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto max-w-6xl px-5 pb-10 text-xs text-faint sm:px-8">© {new Date().getFullYear()} NeuroFlow</div>
    </footer>
  );
}
