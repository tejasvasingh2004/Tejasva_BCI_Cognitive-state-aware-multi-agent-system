import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-45 active:scale-[0.97] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        /** Violet gradient — the primary action (send). */
        primary: 'bg-violet-button text-white shadow-button hover:brightness-110',
        /** Pastel pink→blue gradient pill (image reference CTA). */
        cta: 'bg-cta text-white shadow-soft hover:brightness-105',
        glass: 'glass-strong text-ink-soft hover:text-ink hover:bg-white',
        ghost: 'text-muted hover:bg-white/70 hover:text-ink',
        outline: 'border border-line bg-white/60 text-ink-soft hover:bg-white hover:text-ink',
        danger: 'bg-rose-500 text-white hover:bg-rose-600',
      },
      size: {
        sm: 'h-8 rounded-full px-3 text-xs',
        md: 'h-10 rounded-full px-4 text-sm',
        lg: 'h-12 rounded-full px-6 text-sm',
        icon: 'size-10 rounded-full',
        'icon-sm': 'size-8 rounded-full',
      },
    },
    defaultVariants: { variant: 'glass', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = 'Button';
