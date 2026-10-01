import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { Menu, PanelLeftOpen, PanelRight, PencilLine, Plus } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { keys, useCancelRun, useCognitive, useConversation, useRunView, useSession } from '@/hooks/queries';
import { useConversationRoute } from '@/hooks/route';
import { useUi } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Sparkle } from '@/components/ui/sparkle';
import { Tooltip } from '@/components/ui/tooltip';
import { Inspector } from '@/components/inspector/Inspector';
import { CognitiveControl } from '@/components/panels/CognitiveControl';
import { MemoryDialog } from '@/components/panels/MemoryDialog';
import { SettingsDialog } from '@/components/panels/SettingsDialog';
import { useRunNotifications } from '@/hooks/notifications';
import { Composer, type ComposerHandle } from '@/components/workspace/Composer';
import { Hero } from '@/components/workspace/Hero';
import { Thread } from '@/components/workspace/Thread';
import { Sidebar } from './Sidebar';

export function Workspace() {
  const [conversationId, navigate] = useConversationRoute();
  const { data: detail } = useConversation(conversationId);
  const { data: me } = useSession();
  const qc = useQueryClient();
  const composerRef = useRef<ComposerHandle>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const inspectedRunId = useUi((s) => s.inspectedRunId);
  const toggleInspector = useUi((s) => s.toggleInspector);
  const composer = useUi((s) => s.composer);
  const { data: cognitive } = useCognitive(composer.mode === 'cognitive');

  const lastRun = detail?.runs.at(-1) ?? null;
  const { view: lastView } = useRunView(lastRun?.id ?? null, true);
  const lastStatus = lastView?.status ?? lastRun?.status;
  const running = Boolean(pendingText) || lastStatus === 'queued' || lastStatus === 'running';
  const cancel = useCancelRun();
  const uiDensity = composer.mode === 'cognitive' ? (cognitive?.policy?.uiDensity ?? 'full') : 'full';
  const notificationIntensity = composer.mode === 'cognitive' ? (cognitive?.policy?.notificationIntensity ?? 'medium') : 'high';
  const mobileSidebarOpen = useUi((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useUi((s) => s.setMobileSidebarOpen);
  const notifyOpts = useMemo(
    () => ({
      intensity: notificationIntensity,
      title: detail?.conversation.title ?? 'NeuroFlow',
      onOpen: () => window.focus(),
    }),
    [notificationIntensity, detail?.conversation.title],
  );
  useRunNotifications(lastView, notifyOpts);

  const submit = useCallback(
    async (text: string) => {
      setError(null);
      setPendingText(text);
      try {
        let id = conversationId;
        if (!id) {
          id = (await api.createConversation()).conversation.id;
          navigate(id);
        }
        const tools = !composer.toolsEnabled ? [] : (composer.tools ?? undefined);
        await api.startRun(
          id,
          {
            messages: [{ role: 'user', content: text }],
            mode: composer.mode,
            agentStrategy: composer.agentStrategy,
            ...(composer.model !== 'auto' ? { selectedModel: composer.model } : {}),
            ...(composer.reasoningBudget !== 'auto' ? { reasoningBudget: composer.reasoningBudget } : {}),
            ...(tools ? { tools } : {}),
            ...(composer.agent ? { agent: composer.agent } : {}),
          },
          crypto.randomUUID(),
        );
        await qc.invalidateQueries({ queryKey: keys.conversation(id) });
        void qc.invalidateQueries({ queryKey: keys.conversations });
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Could not reach NeuroFlow. Check that the API is running.');
      } finally {
        setPendingText(null);
      }
    },
    [conversationId, composer, navigate, qc],
  );

  const stop = useCallback(() => {
    if (lastRun && (lastStatus === 'queued' || lastStatus === 'running')) cancel.mutate(lastRun.id);
  }, [cancel, lastRun, lastStatus]);

  const newConversation = useCallback(() => {
    navigate(null);
    setMobileSidebarOpen(false);
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [navigate, setMobileSidebarOpen]);

  // Keyboard: ⌘/Ctrl+K new conversation, ⌘/Ctrl+I inspector, "/" focus composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newConversation();
      } else if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        toggleInspector(inspectedRunId ?? lastRun?.id ?? null);
      } else if (e.key === '/' && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newConversation, toggleInspector, inspectedRunId, lastRun?.id]);

  const showHero = !conversationId || (detail && detail.runs.length === 0 && !pendingText);
  const inspectRun = inspectedRunId ?? lastRun?.id ?? null;
  const firstName = me?.user.displayName.split(' ')[0];

  return (
    <div className="flex h-full gap-3 p-3">
      <AnimatePresence initial={false}>
        {sidebarOpen && (
          <motion.div
            key="sidebar"
            initial={{ opacity: 0, x: -16, width: 0 }}
            animate={{ opacity: 1, x: 0, width: 'auto' }}
            exit={{ opacity: 0, x: -16, width: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="hidden h-full md:block"
          >
            <Sidebar activeId={conversationId} onSelect={navigate} onNew={newConversation} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile: the sidebar is an overlay drawer. */}
      <AnimatePresence>
        {mobileSidebarOpen && (
          <motion.div
            key="mobile-sidebar"
            className="fixed inset-0 z-40 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <button className="absolute inset-0 bg-black/20 backdrop-blur-sm" aria-label="Close menu" onClick={() => setMobileSidebarOpen(false)} />
            <motion.div
              initial={{ x: -24 }}
              animate={{ x: 0 }}
              exit={{ x: -24 }}
              className="absolute inset-y-3 left-3"
            >
              <Sidebar
                activeId={conversationId}
                onSelect={(id) => {
                  navigate(id);
                  setMobileSidebarOpen(false);
                }}
                onNew={newConversation}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="glass relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[28px]">
        {/* top bar */}
        <header className="flex h-16 shrink-0 items-center gap-3 px-4">
          <Button variant="glass" size="icon-sm" className="md:hidden" onClick={() => setMobileSidebarOpen(true)} aria-label="Open menu">
            <Menu className="size-4" />
          </Button>
          {!sidebarOpen && (
            <Tooltip content="Show sidebar">
              <Button variant="glass" size="icon-sm" className="hidden md:inline-flex" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar">
                <PanelLeftOpen className="size-4" />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="New conversation (Ctrl+K)">
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={newConversation} aria-label="New conversation">
              <Plus className="size-4" />
            </Button>
          </Tooltip>
          <ConversationTitle id={conversationId} title={detail?.conversation.title} />

          <div className="ml-auto flex items-center gap-2">
            {running && lastView && notificationIntensity !== 'low' && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-strong hidden h-9 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-xs text-ink-soft lg:flex"
                data-testid="status-pill"
              >
                <span className="flex size-6 items-center justify-center rounded-full bg-violet-soft">
                  <Sparkle className="size-3.5" animated />
                </span>
                <span className="font-medium text-ink">{lastView.phase}</span>
              </motion.div>
            )}
            <CognitiveControl />
            <Tooltip content="Execution inspector (Ctrl+I)">
              <Button
                variant="glass"
                size="icon"
                className={cn('size-9', inspectorOpen && 'bg-violet-soft text-accent')}
                onClick={() => toggleInspector(inspectRun)}
                aria-label="Toggle inspector"
                data-testid="inspector-toggle"
              >
                <PanelRight className="size-4" />
              </Button>
            </Tooltip>
          </div>
        </header>

        <div className="relative min-h-0 flex-1 overflow-y-auto">
          {showHero ? (
            <Hero ref={composerRef} running={running} onSubmit={(t) => void submit(t)} onStop={stop} name={firstName === 'Developer' ? undefined : firstName} />
          ) : detail ? (
            <Thread detail={detail} pendingText={pendingText} onRetry={(t) => void submit(t)} uiDensity={uiDensity} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Sparkle className="size-6" animated />
            </div>
          )}
        </div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mx-auto mb-2 max-w-3xl rounded-full bg-rose-soft px-4 py-2 text-center text-xs text-rose-600"
              role="alert"
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        {!showHero && (
          <div className="shrink-0 px-6 pb-5 pt-2">
            <div className="mx-auto max-w-3xl">
              <Composer ref={composerRef} running={running} onSubmit={(t) => void submit(t)} onStop={stop} />
              <p className="mt-2 text-center text-[11px] text-faint">
                NeuroFlow can make mistakes. Open the inspector to see exactly how an answer was produced.
              </p>
            </div>
          </div>
        )}
      </main>

      <AnimatePresence initial={false}>
        {inspectorOpen && (
          <motion.div
            key="inspector"
            initial={{ opacity: 0, x: 24, width: 0 }}
            animate={{ opacity: 1, x: 0, width: 'auto' }}
            exit={{ opacity: 0, x: 24, width: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="h-full max-lg:fixed max-lg:right-3 max-lg:top-3 max-lg:z-30 max-lg:h-[calc(100%-24px)]"
          >
            <Inspector runId={inspectRun} />
          </motion.div>
        )}
      </AnimatePresence>
      <MemoryDialog />
      <SettingsDialog />
    </div>
  );
}

function ConversationTitle({ id, title }: { id: string | null; title?: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title ?? '');
  useEffect(() => setValue(title ?? ''), [title]);

  if (!id) return <div className="min-w-0 truncate text-sm font-medium text-muted">New conversation</div>;
  const save = async () => {
    setEditing(false);
    if (value.trim() && value !== title) {
      await api.renameConversation(id, value.trim());
      void qc.invalidateQueries({ queryKey: keys.conversation(id) });
      void qc.invalidateQueries({ queryKey: keys.conversations });
    }
  };
  return editing ? (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => e.key === 'Enter' && void save()}
      className="h-8 min-w-0 max-w-md flex-1 rounded-full border border-line bg-surface/80 px-3 text-sm outline-none"
    />
  ) : (
    <button onClick={() => setEditing(true)} className="group flex min-w-0 items-center gap-2 rounded-full px-2 py-1 text-sm font-medium text-ink hover:bg-surface/60">
      <span className="truncate">{title ?? '…'}</span>
      <PencilLine className="size-3.5 shrink-0 text-faint opacity-0 transition group-hover:opacity-100" />
    </button>
  );
}
