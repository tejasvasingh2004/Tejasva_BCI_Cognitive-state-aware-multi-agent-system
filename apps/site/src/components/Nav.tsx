import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { Link, useRoute } from '../router';
import { APP_URL } from '../site';
import { ButtonLink, cn, Logo } from './ui';

const LINKS = [
  { to: '/#features', label: 'Features' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/docs', label: 'Docs' },
  { to: '/changelog', label: 'Changelog' },
  { to: '/download', label: 'Download' },
];

export function Nav() {
  const { path } = useRoute();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => setOpen(false), [path]);

  return (
    <header className="fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-5">
      <div className={cn('glass mx-auto max-w-6xl overflow-hidden rounded-[22px] transition-shadow duration-300', (scrolled || open) && 'shadow-[0_20px_50px_-24px_rgb(30_70_140/0.45)]')} style={{ backgroundColor: 'rgb(246 249 253 / 0.82)' }}>
      <div className="flex h-14 items-center gap-6 px-4 sm:px-5">
        <Link to="/" className="flex items-center gap-2.5" aria-label="NeuroFlow home">
          <Logo />
          <span className="text-[15px] font-bold tracking-tight text-ink">NeuroFlow</span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {LINKS.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={cn('rounded-full px-3 py-1.5 text-sm transition-colors', path === l.to ? 'bg-white/70 text-ink shadow-sm' : 'text-muted hover:bg-white/50 hover:text-ink')}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 md:flex">
          <ButtonLink to="/login" variant="ghost">
            Sign in
          </ButtonLink>
          <ButtonLink href={`${APP_URL}/code`}>Open NeuroFlow</ButtonLink>
        </div>
        <button className="ml-auto rounded-full p-2 text-ink-soft md:hidden" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}>
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      <AnimatePresence>
        {open && (
          <motion.nav
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden border-t border-white/70 md:hidden"
            aria-label="Mobile"
          >
            <div className="flex flex-col gap-1 px-5 py-4">
              {LINKS.map((l) => (
                <Link key={l.to} to={l.to} className="rounded-lg px-3 py-2 text-[15px] text-ink-soft hover:bg-white/60">
                  {l.label}
                </Link>
              ))}
              <div className="mt-2 flex gap-2">
                <ButtonLink to="/login" variant="outline" className="flex-1">
                  Sign in
                </ButtonLink>
                <ButtonLink href={`${APP_URL}/code`} className="flex-1">
                  Open NeuroFlow
                </ButtonLink>
              </div>
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
      </div>
    </header>
  );
}
