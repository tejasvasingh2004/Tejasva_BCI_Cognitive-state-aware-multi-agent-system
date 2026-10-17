import { useEffect, useRef, useState } from 'react';
import type { Check as CheckIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import { Sphere, Stage } from './depth';
import { cn, Eyebrow, Screenshot } from './ui';

export type ScrollFeature = { icon: typeof CheckIcon; eyebrow: string; title: string; body: string; points: string[]; image: string; alt: string };

/**
 * Scroll story: text steps on the left, a pinned 3D screen on the right whose screenshots deal
 * forward like cards as each step reaches the middle of the viewport.
 */
export function FeatureScroller({ items }: { items: ScrollFeature[] }) {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="grid gap-10 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:gap-14">
      <div>
        {items.map((f, i) => (
          <div
            key={f.title}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-i={i}
            className="flex flex-col justify-center py-10 md:min-h-[78vh] md:py-0"
          >
            <div className={cn('transition-opacity duration-500 md:opacity-35', active === i && 'md:opacity-100')}>
              <div className="flex items-center gap-3">
                <span className="sphere sphere-ice flex size-10 items-center justify-center">
                  <f.icon className="size-4 text-accent" />
                </span>
                <Eyebrow>
                  {String(i + 1).padStart(2, '0')} · {f.eyebrow}
                </Eyebrow>
              </div>
              <h3 className="mt-5 text-2xl font-bold tracking-tight sm:text-[2rem] sm:leading-tight">{f.title}</h3>
              <p className="mt-4 text-[15.5px] leading-7 text-muted">{f.body}</p>
              <ul className="mt-5 space-y-2">
                {f.points.map((p) => (
                  <li key={p} className="flex gap-2 text-sm text-ink-soft">
                    <Check className="mt-0.5 size-4 shrink-0 text-accent" /> {p}
                  </li>
                ))}
              </ul>
            </div>
            <Screenshot src={f.image} alt={f.alt} className="mt-8 md:hidden" />
          </div>
        ))}
      </div>

      <div className="hidden md:block">
        <Stage className="sticky top-24 flex h-[calc(100vh-7rem)] items-center">
          <div className="relative w-full" style={{ perspective: '1800px' }}>
            <div className="depth absolute -left-8 -top-10" style={{ '--d': 30 } as React.CSSProperties}>
              <Sphere size={58} tone="sky" className="float" />
            </div>
            <div className="depth absolute -bottom-12 -right-6 z-20" style={{ '--d': 60 } as React.CSSProperties}>
              <Sphere size={110} tone="ice" className="float" />
            </div>
            <div className="relative aspect-[16/10.4]">
              {items.map((f, i) => {
                const o = i - active;
                const style: React.CSSProperties =
                  o === 0
                    ? { transform: 'translate3d(0,0,0) rotateY(-9deg) rotateX(5deg)', opacity: 1, zIndex: 10 }
                    : o < 0
                      ? { transform: 'translate3d(-6%,-26%,-260px) rotateX(38deg) rotateY(-14deg)', opacity: 0, zIndex: 1 }
                      : { transform: `translate3d(${o * 5}%, ${o * 6}%, ${-o * 120}px) rotateY(-14deg) rotateX(6deg)`, opacity: o > 2 ? 0 : 0.55 / o, zIndex: 10 - o };
                return (
                  <div
                    key={f.image}
                    className="absolute inset-0 transition-[transform,opacity] duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                    style={{ ...style, transformOrigin: '50% 60%' }}
                    aria-hidden={o !== 0}
                  >
                    <Screenshot src={f.image} alt={f.alt} className="shadow-[0_60px_120px_-40px_rgb(25_60_125/0.55)]" />
                  </div>
                );
              })}
            </div>
          </div>
        </Stage>
      </div>
    </div>
  );
}
