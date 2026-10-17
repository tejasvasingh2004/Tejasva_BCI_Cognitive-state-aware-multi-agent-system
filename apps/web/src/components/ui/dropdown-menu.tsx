import type { ComponentProps, ReactNode } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({ className, children, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={8}
        className={cn(
          'glass-strong z-50 min-w-52 rounded-2xl p-1.5 text-sm',
          className,
        )}
        {...props}
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <Menu.Label className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</Menu.Label>;
}

export function DropdownMenuItem({
  className,
  selected,
  hint,
  children,
  ...props
}: ComponentProps<typeof Menu.Item> & { selected?: boolean; hint?: ReactNode }) {
  return (
    <Menu.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-xl px-3 py-2 text-ink-soft outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-violet-soft data-[highlighted]:text-ink',
        className,
      )}
      {...props}
    >
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
      {selected && <Check className="size-4 text-accent" />}
    </Menu.Item>
  );
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-line" />;
}
