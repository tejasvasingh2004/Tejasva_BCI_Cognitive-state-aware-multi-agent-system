import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Link } from '../router';

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex size-7 items-center justify-center rounded-full bg-raised ring-1 ring-line', className)} aria-hidden>
      <span className="absolute inset-[5px] rounded-full border-2 border-accent/90" />
      <span className="absolute right-[3px] top-[5px] size-1.5 rounded-full bg-accent-soft" />
    </span>
  );
}

type ButtonProps = { children: ReactNode; className?: string; variant?: 'primary' | 'ghost' | 'outline'; size?: 'md' | 'lg' };
const buttonClass = (variant: ButtonProps['variant'] = 'primary', size: ButtonProps['size'] = 'md') =>
  cn(
    'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    size === 'lg' ? 'h-12 px-6 text-[15px]' : 'h-10 px-4 text-sm',
    variant === 'primary' && 'bg-ink text-canvas hover:bg-white',
    variant === 'outline' && 'border border-line bg-panel/60 text-ink hover:border-faint hover:bg-raised',
    variant === 'ghost' && 'text-ink-soft hover:text-ink',
  );

/** Button that navigates inside the site (`to`) or to another origin (`href`). */
export function ButtonLink({ to, href, ...props }: ButtonProps & { to?: string; href?: string }) {
  const className = cn(buttonClass(props.variant, props.size), props.className);
  if (to) return <Link to={to} className={className}>{props.children}</Link>;
  return (
    <a href={href} className={className}>
      {props.children}
    </a>
  );
}

export function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={cn('mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 md:py-28', className)}>
      {children}
    </section>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-xs font-semibold uppercase tracking-[0.18em] text-accent-soft', className)}>{children}</p>;
}

/**
 * Fades content in when it scrolls into view. Content is visible in the pre-rendered HTML (no-JS
 * visitors and crawlers see everything); only elements below the fold at load time animate.
 */
export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'static' | 'hidden' | 'shown'>('static');
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    setState('hidden');
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setState('shown');
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -60px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={cn(className, 'transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]', state === 'hidden' && 'translate-y-4 opacity-0')}
      style={state === 'shown' && delay ? { transitionDelay: `${delay}s` } : undefined}
    >
      {children}
    </div>
  );
}

/** A real product screenshot in a window frame. */
export function Screenshot({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-line bg-panel glow', className)}>
      <div className="flex h-8 items-center gap-1.5 border-b border-line px-3">
        <span className="size-2.5 rounded-full bg-[#3a3550]" />
        <span className="size-2.5 rounded-full bg-[#3a3550]" />
        <span className="size-2.5 rounded-full bg-[#3a3550]" />
      </div>
      <img src={src} alt={alt} width={1440} height={900} loading="lazy" decoding="async" className="block h-auto w-full" />
    </div>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="relative">
      <div className="grid-bg pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-4xl px-5 pb-6 pt-36 text-center sm:px-8">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-ink sm:text-5xl">{title}</h1>
        {children && <div className="mx-auto mt-5 max-w-2xl text-[17px] leading-7 text-muted">{children}</div>}
      </div>
    </div>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-line bg-panel px-4 py-3 font-mono text-[13px] leading-6 text-ink-soft">
      <code>{children}</code>
    </pre>
  );
}
