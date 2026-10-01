import { lazy, Suspense } from 'react';
import { Sparkle } from '@/components/ui/sparkle';
import { CodeHome } from './CodeHome';
import { ReplayView } from './ReplayView';

// Monaco is large: load the workspace (and the editor) only when a workspace is opened.
const CodeWorkspace = lazy(() => import('./CodeWorkspace').then((m) => ({ default: m.CodeWorkspace })));

export function CodeApp({ workspaceId, replayRunId }: { workspaceId: string | null; replayRunId: string | null }) {
  if (!workspaceId) return <CodeHome />;
  if (replayRunId) return <ReplayView workspaceId={workspaceId} runId={replayRunId} />;
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
