import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from './ui';

/**
 * Depth primitives for the site. Everything renders complete on the server; the browser only adds
 * motion by writing CSS variables (no React re-renders per frame).
 */

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const svgId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '');

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/**
 * A region whose children react to the pointer (--px/--py in -1…1) and to scroll:
 * - `scroll="exit"`: --sy goes 0 → 1 while the region scrolls out of the top of the viewport;
 * - `scroll="enter"`: --p goes 0 → 1 while the region scrolls into view (1 when fully in).
 */
export function Stage({ children, className, scroll = 'exit', style }: { children: ReactNode; className?: string; scroll?: 'exit' | 'enter'; style?: Vars }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const fine = window.matchMedia('(pointer: fine)').matches;
    let tx = 0, ty = 0, x = 0, y = 0;
    let raf = 0;
    let visible = true;
    const frame = () => {
      raf = 0;
      x += (tx - x) * 0.07;
      y += (ty - y) * 0.07;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      el.style.setProperty('--px', x.toFixed(4));
      el.style.setProperty('--py', y.toFixed(4));
      if (scroll === 'exit') el.style.setProperty('--sy', clamp(-r.top / Math.max(r.height, 1)).toFixed(4));
      else el.style.setProperty('--p', clamp((vh - r.top) / (vh * 0.7)).toFixed(4));
      if (Math.abs(tx - x) > 0.0005 || Math.abs(ty - y) > 0.0005) kick();
    };
    const kick = () => {
      if (!raf && visible) raf = requestAnimationFrame(frame);
    };
    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth) * 2 - 1;
      ty = (e.clientY / window.innerHeight) * 2 - 1;
      kick();
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      kick();
    });
    io.observe(el);
    if (fine) window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick);
    kick();
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', kick);
      window.removeEventListener('resize', kick);
    };
  }, [scroll]);
  return (
    <div ref={ref} className={cn('stage', scroll === 'enter' && 'stage-enter', className)} style={style}>
      {children}
    </div>
  );
}

/**
 * An object placed in a Stage: `depth` sets how strongly it follows the pointer and scroll, `rotate`
 * gives it a resting 3D orientation (degrees) that also leans toward the pointer.
 */
export function Layer({
  children,
  className,
  depth = 20,
  rotate,
  float = true,
  enter,
  duration,
  style,
}: {
  children: ReactNode;
  className?: string;
  depth?: number;
  rotate?: [number, number, number];
  float?: boolean;
  /** Entrance delay in seconds (assemble animation on load). */
  enter?: number;
  duration?: number;
  style?: Vars;
}) {
  const vars: Vars = { '--d': depth, ...(duration ? { '--dur': `${duration}s` } : {}), ...(enter !== undefined ? { '--in': `${enter}s` } : {}), ...style };
  const inner: Vars | undefined = rotate ? { '--rx0': `${rotate[0]}deg`, '--ry0': `${rotate[1]}deg`, '--rz0': `${rotate[2]}deg` } : undefined;
  return (
    <div className={cn('depth absolute', className)} style={vars}>
      <div className={cn(enter !== undefined ? 'assemble' : float && 'float')}>
        <div className={rotate ? 'tilt3d' : undefined} style={inner}>
          {children}
        </div>
      </div>
    </div>
  );
}

export type SphereTone = 'sky' | 'ice' | 'mist' | 'cobalt' | 'glass';
export function Sphere({ size, tone = 'ice', className }: { size: number; tone?: SphereTone; className?: string }) {
  return <div aria-hidden className={cn('sphere', `sphere-${tone}`, className)} style={{ width: size, height: size }} />;
}

/** A glossy ribbon with a cyan edge, like a bent sheet of clear glass. */
export function Ribbon({ className, variant = 'a' }: { className?: string; variant?: 'a' | 'b' | 'c' }) {
  const id = svgId(useId());
  const d = {
    a: 'M-30 104 C 30 118, 64 30, 122 36 S 196 92, 250 36',
    b: 'M-30 40 C 40 20, 70 110, 130 96 S 200 20, 250 54',
    c: 'M-30 80 C 60 130, 110 -10, 250 60',
  }[variant];
  return (
    <svg viewBox="0 0 220 140" className={cn('pointer-events-none', className)} aria-hidden fill="none">
      <defs>
        <linearGradient id={`${id}b`} x1="0" x2="1" y1="0" y2="0.3">
          <stop offset="0" stopColor="#d9e8f6" />
          <stop offset="0.45" stopColor="#ffffff" />
          <stop offset="0.75" stopColor="#e1edf9" />
          <stop offset="1" stopColor="#b9d3ee" />
        </linearGradient>
        <linearGradient id={`${id}e`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#2f63b8" />
          <stop offset="0.35" stopColor="#8fd0ee" />
          <stop offset="0.55" stopColor="#ffffff" />
          <stop offset="0.75" stopColor="#5bb1e6" />
          <stop offset="1" stopColor="#2a5cb0" />
        </linearGradient>
        <filter id={`${id}s`} x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="6" floodColor="#1f4f9a" floodOpacity="0.28" />
        </filter>
      </defs>
      <g filter={`url(#${id}s)`}>
        <path d={d} stroke={`url(#${id}b)`} strokeWidth="18" strokeLinecap="round" />
        <path d={d} stroke={`url(#${id}e)`} strokeWidth="3" strokeLinecap="round" transform="translate(0 8.5)" />
        <path d={d} stroke="#fff" strokeOpacity="0.85" strokeWidth="1.3" strokeLinecap="round" transform="translate(0 -7)" />
      </g>
    </svg>
  );
}

/** Deterministic PRNG so the server and the browser draw the same speckles. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Terrazzo stone texture. */
export function Terrazzo({ className, seed = 7, base = '#e6eef7' }: { className?: string; seed?: number; base?: string }) {
  const id = svgId(useId());
  const chips = useMemo(() => {
    const rnd = mulberry32(seed);
    const colors = ['#a6bbd3', '#6d86a6', '#ffffff', '#c5d5e7', '#89a5c6', '#f3f7fb', '#4c6585'];
    return Array.from({ length: 90 }, () => ({
      x: (rnd() * 140).toFixed(1),
      y: (rnd() * 140).toFixed(1),
      rx: (0.5 + rnd() * (rnd() > 0.9 ? 3.4 : 1.6)).toFixed(1),
      ry: (0.4 + rnd() * 1.4).toFixed(1),
      r: Math.round(rnd() * 180),
      c: colors[Math.floor(rnd() * colors.length)]!,
    }));
  }, [seed]);
  return (
    <svg className={cn('pointer-events-none', className)} aria-hidden preserveAspectRatio="xMidYMid slice">
      <defs>
        <pattern id={id} width="140" height="140" patternUnits="userSpaceOnUse">
          <rect width="140" height="140" fill={base} />
          {chips.map((c, i) => (
            <ellipse key={i} cx={c.x} cy={c.y} rx={c.rx} ry={c.ry} fill={c.c} transform={`rotate(${c.r} ${c.x} ${c.y})`} />
          ))}
        </pattern>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#25456f" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
      <rect width="100%" height="100%" fill={`url(#${id}l)`} />
    </svg>
  );
}

/** A card that tilts toward the pointer with a moving glare (fine pointers only). */
export function Tilt({ children, className, max = 7 }: { children: ReactNode; className?: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || !window.matchMedia('(pointer: fine)').matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      el.dataset.active = '';
      el.style.setProperty('--rx', `${((0.5 - y) * max).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${((x - 0.5) * max).toFixed(2)}deg`);
      el.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
      el.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
    };
    const leave = () => {
      delete el.dataset.active;
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [max]);
  return (
    <div ref={ref} className={cn('tilt relative', className)}>
      {children}
      <div className="tilt-glare pointer-events-none absolute inset-0 rounded-[inherit]" aria-hidden />
    </div>
  );
}

/** Counts up to `value` when scrolled into view; the pre-rendered HTML shows the final number. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || el.getBoundingClientRect().top < window.innerHeight) return;
    setShown(0);
    let raf = 0;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (t: number) => {
        const k = clamp((t - start) / 1200);
        setShown(Math.round(value * (1 - Math.pow(1 - k, 3))));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value]);
  return (
    <span ref={ref} className={className}>
      {shown}
    </span>
  );
}
