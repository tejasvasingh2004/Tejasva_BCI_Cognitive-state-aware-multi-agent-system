import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookMarked, Plus, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/utils';
import { keys, useMemories } from '@/hooks/queries';
import { useUi } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/** User-controlled memory: everything NeuroFlow may recall is visible and removable here. */
export function MemoryDialog() {
  const open = useUi((s) => s.memoryOpen);
  const setOpen = useUi((s) => s.setMemoryOpen);
  const { data: memories = [], isLoading } = useMemories(open);
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await api.addMemory(draft.trim());
      setDraft('');
      await qc.invalidateQueries({ queryKey: keys.memories });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await api.deleteMemory(id);
    await qc.invalidateQueries({ queryKey: keys.memories });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen} title="Memory" description="Facts and decisions NeuroFlow can recall when relevant. Only you can see them.">
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="e.g. We decided pricing is $29 per seat"
          className="h-10 flex-1 rounded-full border border-line bg-surface/80 px-4 text-sm outline-none placeholder:text-faint focus:border-accent/40"
          data-testid="memory-input"
        />
        <Button variant="primary" onClick={() => void add()} disabled={busy || !draft.trim()}>
          <Plus className="size-4" /> Remember
        </Button>
      </div>
      <div className="mt-4 -mr-2 flex-1 space-y-2 overflow-y-auto pr-2">
        {isLoading && <p className="py-6 text-center text-sm text-muted">Loading…</p>}
        {!isLoading && memories.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted">
            <BookMarked className="size-5 text-faint" />
            Nothing remembered yet.
          </div>
        )}
        <AnimatePresence initial={false}>
          {memories.map((m) => (
            <motion.div
              key={m.id}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 12 }}
              className="group flex items-start gap-3 rounded-2xl border border-surface bg-surface/70 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-6 text-ink">{m.content}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                  <span>{m.source === 'agent' ? 'Saved by NeuroFlow' : 'Added by you'}</span>
                  <span>·</span>
                  <span>{relativeTime(m.createdAt)}</span>
                  {m.tags.map((t) => (
                    <span key={t} className="rounded-full bg-violet-soft px-2 text-accent">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <button
                onClick={() => void remove(m.id)}
                className="rounded-full p-1.5 text-faint opacity-0 transition hover:bg-rose-soft hover:text-rose-500 group-hover:opacity-100"
                aria-label="Forget"
              >
                <Trash2 className="size-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Dialog>
  );
}
