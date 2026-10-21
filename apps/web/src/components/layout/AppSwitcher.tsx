import { BarChart3, Code2, FlaskConical, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { navigateTo, useAppRoute } from '@/hooks/route';

const APPS = [
  { app: 'chat', label: 'Chat', icon: MessageSquare, path: '/' },
  { app: 'code', label: 'Code', icon: Code2, path: '/code' },
  { app: 'lab', label: 'Model Lab', icon: FlaskConical, path: '/lab' },
  { app: 'usage', label: 'Usage', icon: BarChart3, path: '/usage' },
] as const;

/** Switches between the AI workspace, the Code workspace, Model Lab and Usage (one product, one runtime). */
export function AppSwitcher({ className, compact }: { className?: string; compact?: boolean }) {
  const route = useAppRoute();
  return (
    <nav className={cn('flex items-center gap-0.5 rounded-full bg-surface/60 p-0.5', className)} aria-label="NeuroFlow apps">
      {APPS.map(({ app, label, icon: Icon, path }) => {
        const active = route.app === app;
        return (
          <button
            key={app}
            onClick={() => navigateTo(path)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition',
              active ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:text-ink',
            )}
            aria-current={active ? 'page' : undefined}
            data-testid={`app-${app}`}
          >
            <Icon className={cn('size-3.5', active && 'text-accent')} />
            {!compact && label}
          </button>
        );
      })}
    </nav>
  );
}
