import { motion } from 'framer-motion';
import { useSession } from '@/hooks/queries';
import { Background } from '@/components/layout/Background';
import { Workspace } from '@/components/layout/Workspace';
import { Sparkle } from '@/components/ui/sparkle';
import { Button } from '@/components/ui/button';

export function App() {
  const session = useSession();

  return (
    <>
      <Background />
      {session.isSuccess ? (
        <Workspace />
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass flex max-w-sm flex-col items-center rounded-[28px] px-10 py-10 text-center">
            <Sparkle className="size-9" animated={session.isLoading} />
            <h1 className="mt-4 text-xl font-semibold text-ink">{session.isLoading ? 'Opening your workspace…' : 'Can’t reach NeuroFlow'}</h1>
            {session.isError && (
              <>
                <p className="mt-2 text-sm leading-6 text-muted">
                  The API is not responding or you are not signed in. Start the API (<code>pnpm dev</code>) and try again.
                </p>
                <Button variant="primary" className="mt-6" onClick={() => void session.refetch()}>
                  Try again
                </Button>
              </>
            )}
          </motion.div>
        </div>
      )}
    </>
  );
}
