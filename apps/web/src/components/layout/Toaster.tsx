import { AnimatePresence, motion } from 'framer-motion';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToasts } from '@/stores/toasts';

const ICON = { success: CircleCheck, error: CircleAlert, info: Info };
const TONE = { success: 'text-emerald-500', error: 'text-rose-500', info: 'text-accent' };

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed right-5 top-20 z-50 flex w-[min(360px,calc(100vw-40px))] flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24 }}
              className="glass-strong pointer-events-auto flex items-start gap-3 rounded-2xl p-3.5"
              data-testid="toast"
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', TONE[t.tone])} />
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  t.onClick?.();
                  dismiss(t.id);
                }}
              >
                <div className="text-sm font-medium text-ink">{t.title}</div>
                {t.body && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{t.body}</div>}
              </button>
              <button onClick={() => dismiss(t.id)} className="rounded-full p-1 text-faint hover:text-ink" aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
