import type { ReactNode } from 'react';
import { ArrowLeft, Code2, History, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCodeWorkspace } from '@/hooks/code';
import { navigateTo, useAppRoute, useDocumentTitle } from '@/hooks/route';
import { Logo, Sparkle } from '@/components/ui/sparkle';
import { AppSwitcher } from '@/components/layout/AppSwitcher';
import { errorMessage } from './shared';

const VIEWS = [
  { id: 'workspace', label: 'Editor', icon: Code2, suffix: '' },
  { id: 'tasks', label: 'Tasks', icon: History, suffix: '/tasks' },
  { id: 'settings', label: 'Settings', icon: Settings2, suffix: '/settings' },
] as const;

/** Editor · Tasks · Settings navigation of one code workspace. */
export function WorkspaceNav({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const route = useAppRoute();
  const current = route.app === 'code' ? route.view : 'workspace';
  return (
    <nav className={cn('flex items-center gap-0.5 rounded-full bg-surface/60 p-0.5', className)} aria-label="Workspace">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          onClick={() => navigateTo(`/code/${workspaceId}${v.suffix}`)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition',
            current === v.id ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:text-ink',
          )}
          aria-current={current === v.id ? 'page' : undefined}
          data-testid={`ws-nav-${v.id}`}
        >
          <v.icon className={cn('size-3.5', current === v.id && 'text-accent')} />
          {v.label}
        </button>
      ))}
    </nav>
  );
}

/** Page frame for workspace pages other than the editor (Tasks, Settings). */
export function WorkspacePage({ workspaceId, title, children }: { workspaceId: string; title: string; children: ReactNode }) {
  const { data, error, isLoading } = useCodeWorkspace(workspaceId);
  useDocumentTitle(data ? `${title} · ${data.workspace.repository.name} · NeuroFlow Code` : `${title} · NeuroFlow Code`);
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <header className="glass flex h-12 shrink-0 items-center gap-2 rounded-[20px] px-3">
        <button onClick={() => navigateTo('/code')} aria-label="All workspaces">
          <Logo className="size-6" />
        </button>
        <AppSwitcher compact className="hidden md:flex" />
        <div className="mx-1 h-5 w-px bg-line" />
        <span className="min-w-0 truncate text-sm font-semibold text-ink">{data?.workspace.repository.fullName ?? '…'}</span>
        <WorkspaceNav workspaceId={workspaceId} className="ml-auto" />
      </header>
      <main className="glass min-h-0 flex-1 overflow-y-auto rounded-[24px]">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Sparkle className="size-7" animated />
          </div>
        ) : error || !data ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-ink">
            {errorMessage(error, 'Workspace not found')}
            <button className="flex items-center gap-1 text-xs text-accent" onClick={() => navigateTo('/code')}>
              <ArrowLeft className="size-3.5" /> All workspaces
            </button>
          </div>
        ) : (
          <div className="mx-auto max-w-5xl px-6 py-6">{children}</div>
        )}
      </main>
    </div>
  );
}
