import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookMarked, MessageSquare, PanelLeftClose, Plus, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Conversation } from '@neuroflow/contracts';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { keys, useConversations, useSession } from '@/hooks/queries';
import { useUi } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/ui/sparkle';
import { Tooltip } from '@/components/ui/tooltip';

function groupByRecency(list: Conversation[]) {
  const today = new Date().toDateString();
  const groups: Record<string, Conversation[]> = { Today: [], 'Previous 7 days': [], Earlier: [] };
  for (const c of list) {
    const d = new Date(c.updatedAt);
    if (d.toDateString() === today) groups.Today!.push(c);
    else if (Date.now() - d.getTime() < 7 * 86_400_000) groups['Previous 7 days']!.push(c);
    else groups.Earlier!.push(c);
  }
  return Object.entries(groups).filter(([, v]) => v.length > 0);
}

export function Sidebar({ activeId, onSelect, onNew }: { activeId: string | null; onSelect(id: string): void; onNew(): void }) {
  const { data: conversations = [] } = useConversations();
  const { data: me } = useSession();
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const setMemoryOpen = useUi((s) => s.setMemoryOpen);
  const qc = useQueryClient();
  const groups = useMemo(() => groupByRecency(conversations), [conversations]);

  const remove = async (id: string) => {
    await api.deleteConversation(id);
    await qc.invalidateQueries({ queryKey: keys.conversations });
    if (id === activeId) onNew();
  };

  return (
    <aside className="glass flex h-full w-72 shrink-0 flex-col rounded-[28px] p-4">
      <div className="flex items-center gap-3 px-1">
        <Logo />
        <div className="flex-1">
          <div className="text-[15px] font-semibold tracking-tight text-ink">NeuroFlow</div>
          <div className="text-[11px] text-muted">AI workspace</div>
        </div>
        <Tooltip content="Collapse sidebar">
          <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(false)} aria-label="Collapse sidebar">
            <PanelLeftClose className="size-4" />
          </Button>
        </Tooltip>
      </div>

      <Button variant="cta" size="md" className="mt-5 w-full" onClick={onNew} data-testid="new-chat">
        <Plus className="size-4" /> New conversation
      </Button>

      <nav className="-mx-1 mt-5 flex-1 overflow-y-auto px-1" aria-label="Conversations">
        {groups.length === 0 && (
          <p className="px-3 py-6 text-center text-xs leading-5 text-faint">Your conversations will appear here.</p>
        )}
        {groups.map(([label, items]) => (
          <div key={label} className="mb-4">
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{label}</div>
            <AnimatePresence initial={false}>
              {items.map((c) => (
                <motion.div
                  key={c.id}
                  layout
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -6 }}
                  className={cn(
                    'group flex items-center gap-2.5 rounded-2xl px-3 py-2 text-sm transition-colors',
                    c.id === activeId ? 'bg-white text-ink shadow-soft' : 'text-ink-soft hover:bg-white/60',
                  )}
                >
                  <MessageSquare className={cn('size-4 shrink-0', c.id === activeId ? 'text-accent' : 'text-faint')} />
                  <button className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(c.id)} title={c.title}>
                    {c.title}
                  </button>
                  <button
                    className="rounded-full p-1 text-faint opacity-0 transition hover:bg-rose-soft hover:text-rose-500 group-hover:opacity-100"
                    onClick={() => void remove(c.id)}
                    aria-label={`Delete ${c.title}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ))}
      </nav>

      <div className="mt-2 space-y-2 border-t border-white/70 pt-3">
        <button
          onClick={() => setMemoryOpen(true)}
          className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-sm text-ink-soft transition hover:bg-white/60"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-mint-soft text-emerald-600">
            <BookMarked className="size-3.5" />
          </span>
          Memory
        </button>
        {me && (
          <div className="flex items-center gap-3 rounded-2xl px-3 py-2">
            <div className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-300 to-sky-300 text-xs font-semibold text-white">
              {me.user.displayName.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink">{me.user.displayName}</div>
              <div className="truncate text-[11px] text-muted">{me.workspace.name}</div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
