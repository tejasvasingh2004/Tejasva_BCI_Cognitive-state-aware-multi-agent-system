import { lazy, Suspense } from 'react';
import type { CodeView } from '@/hooks/route';
import { Sparkle } from '@/components/ui/sparkle';
import { CodeHome } from './CodeHome';
import { ReplayView } from './ReplayView';
import { TasksPage } from './TasksPage';
import { WorkspaceSettingsPage } from './WorkspaceSettingsPage';

// Monaco is large: load the workspace (and the editor) only when a workspace is opened.
const CodeWorkspace = lazy(() => import('./CodeWorkspace').then((m) => ({ default: m.CodeWorkspace })));

export function CodeApp({ workspaceId, replayRunId, view = 'workspace' }: { workspaceId: string | null; replayRunId: string | null; view?: CodeView }) {
  if (!workspaceId) return <CodeHome />;
  if (replayRunId) return <ReplayView workspaceId={workspaceId} runId={replayRunId} />;
  if (view === 'tasks') return <TasksPage workspaceId={workspaceId} />;
  if (view === 'settings') return <WorkspaceSettingsPage workspaceId={workspaceId} />;
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Sparkle className="size-7" animated />
        </div>
      }
    >
      <CodeWorkspace key={workspaceId} id={workspaceId} />
    </Suspense>
  );
}
