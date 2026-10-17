import { useEffect, useRef } from 'react';
import type { Density } from '@neuroflow/contracts';
import type { RunView } from '@/lib/run-view';
import { useToasts } from '@/stores/toasts';

/**
 * Run completion notifications, scaled by notification intensity (Cognitive Mode policy;
 * Standard Mode uses "high"):
 * - high:   in-app toast + desktop notification when the tab is hidden
 * - medium: in-app toast only
 * - low:    no interruptions; only a quiet tab-title badge while the tab is hidden
 * Failures are always visible inline in the conversation regardless of intensity.
 */
export function useRunNotifications(view: RunView | null, opts: { intensity: Density; title: string; onOpen(): void }) {
  const previous = useRef<RunView['status'] | undefined>(undefined);
  const push = useToasts((s) => s.push);
  const baseTitle = useRef(document.title);

  useEffect(() => {
    const status = view?.status;
    const was = previous.current;
    previous.current = status;
    if (!status || !was || (was !== 'running' && was !== 'queued')) return;
    if (status !== 'completed' && status !== 'failed') return;

    const ok = status === 'completed';
    const title = ok ? 'Task completed' : 'Task failed';
    const body = ok ? opts.title : (view?.error?.message ?? opts.title);

    if (document.hidden) document.title = `${ok ? '✓' : '!'} ${baseTitle.current}`;
    if (opts.intensity === 'low') return;

    push({ title, body, tone: ok ? 'success' : 'error', onClick: opts.onOpen });
    if (opts.intensity === 'high' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`NeuroFlow · ${title}`, { body, tag: 'neuroflow-run' });
      n.onclick = () => {
        window.focus();
        opts.onOpen();
      };
    }
  }, [view?.status, view?.error?.message, opts, push]);

  useEffect(() => {
    const reset = () => {
      if (!document.hidden) document.title = baseTitle.current;
    };
    document.addEventListener('visibilitychange', reset);
    return () => document.removeEventListener('visibilitychange', reset);
  }, []);
}
