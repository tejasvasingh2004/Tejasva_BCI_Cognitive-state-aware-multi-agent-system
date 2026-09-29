import { cn } from '@/lib/utils';

/** Four-point star used as NeuroFlow's mark (reference: the violet sparkle above the greeting). */
export function Sparkle({ className, animated }: { className?: string; animated?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-6', animated && 'animate-pulse', className)} aria-hidden>
      <defs>
        <linearGradient id="nf-sparkle" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d8b4fe" />
          <stop offset="0.55" stopColor="#a855f7" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <path
        fill="url(#nf-sparkle)"
        d="M12 1.5c.8 5.6 3.4 8.2 9 9-5.6.8-8.2 3.4-9 9-.8-5.6-3.4-8.2-9-9 5.6-.8 8.2-3.4 9-9z"
        transform="translate(0 1.5)"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('relative flex size-9 items-center justify-center rounded-full bg-white shadow-soft', className)}>
      <div className="absolute inset-[5px] rounded-full border-[2.5px] border-accent/80" />
      <div className="absolute right-[3px] top-[7px] size-2 rounded-full bg-accent" />
    </div>
  );
}
