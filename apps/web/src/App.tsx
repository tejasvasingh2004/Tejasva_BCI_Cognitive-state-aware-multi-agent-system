import { lazy, Suspense } from 'react';
import { motion } from 'framer-motion';
import { LoginRequiredError, useSession } from '@/hooks/queries';
import { useApplyTheme } from '@/hooks/theme';
import { Background } from '@/components/layout/Background';
import { LoginScreen } from '@/components/layout/LoginScreen';
import { Toaster } from '@/components/layout/Toaster';
import { Workspace } from '@/components/layout/Workspace';
import { Sparkle } from '@/components/ui/sparkle';
import { Button } from '@/components/ui/button';
import { useAppRoute } from '@/hooks/route';

// Code workspace and Model Lab load on demand so the chat workspace stays light.
const CodeApp = lazy(() => import('@/components/code/CodeApp').then((m) => ({ default: m.CodeApp })));
const ModelLab = lazy(() => import('@/components/lab/ModelLab').then((m) => ({ default: m.ModelLab })));

export function App() {
  useApplyTheme();
  const session = useSession();
  const route = useAppRoute();

  return (
    <>
      <Background />
      {session.isSuccess ? (
        route.app === 'code' || route.app === 'lab' ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Sparkle className="size-7" animated />
              </div>
            }
          >
            {route.app === 'code' ? <CodeApp workspaceId={route.workspaceId} replayRunId={route.replayRunId} view={route.view} /> : <ModelLab section={route.section} />}
          </Suspense>
        ) : (
          <Workspace />
        )
      ) : session.error instanceof LoginRequiredError ? (
        <LoginScreen />
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass flex max-w-sm flex-col items-center rounded-[28px] px-10 py-10 text-center">
            <Sparkle className="size-9" animated={session.isLoading} />
            <h1 className="mt-4 text-xl font-semibold text-ink">{session.isLoading ? 'Opening your workspace…' : 'Can’t reach NeuroFlow'}</h1>
            {session.isError && (
              <>
                <p className="mt-2 text-sm leading-6 text-muted">
                  The API is not responding. Start it (<code>pnpm dev</code>) and try again.
                </p>
                <Button variant="primary" className="mt-6" onClick={() => void session.refetch()}>
                  Try again
                </Button>
              </>
            )}
          </motion.div>
        </div>
      )}
      <Toaster />
    </>
  );
}
