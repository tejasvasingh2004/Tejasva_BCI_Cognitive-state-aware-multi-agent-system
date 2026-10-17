import { API_BASE } from './api';
import { readFrames } from './run-stream';

/** A live (non-persisted) event of a code workspace: sync status, terminal output, file changes. */
export type WorkspaceEvent = { type: string; data: Record<string, unknown>; ts: string };

/**
 * Follows a code workspace's live event channel over SSE, reconnecting with backoff. Agent run
 * events are not on this channel — they arrive on the run's own stream.
 */
export function followWorkspace(
  codeWorkspaceId: string,
  opts: { onEvent: (event: WorkspaceEvent) => void; onStateChange?: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => void },
): () => void {
  const controller = new AbortController();
  const loop = async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      opts.onStateChange?.(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const res = await fetch(`${API_BASE}/v1/code/workspaces/${codeWorkspaceId}/events`, {
          credentials: 'include',
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (res.status === 404 || res.status === 401 || res.status === 403) break;
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        opts.onStateChange?.('open');
        attempt = 0;
        for await (const data of readFrames(res.body)) {
          try {
            opts.onEvent(JSON.parse(data) as WorkspaceEvent);
          } catch {
            // Ignore malformed frames (e.g. keep-alive comments).
          }
        }
      } catch {
        if (controller.signal.aborted) break;
      }
      attempt++;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(500 * 2 ** attempt, 8000));
        controller.signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    opts.onStateChange?.('closed');
  };
  void loop();
  return () => controller.abort();
}
