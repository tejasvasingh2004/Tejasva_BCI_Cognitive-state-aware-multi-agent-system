import { isTerminalEvent, type RunEvent } from '@neuroflow/contracts';
import { API_BASE } from './api';

/**
 * Follows a run's realtime events over SSE with automatic resume. A fetch-based reader (rather
 * than EventSource) lets us stop cleanly after the terminal event and resume from the last seen
 * sequence number after network interruptions.
 */
export function followRun(
  runId: string,
  opts: {
    afterSeq?: number;
    onEvent: (event: RunEvent) => void;
    onStateChange?: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
  },
): () => void {
  const controller = new AbortController();
  let lastSeq = opts.afterSeq ?? 0;
  let done = false;

  const loop = async () => {
    let attempt = 0;
    while (!done && !controller.signal.aborted) {
      opts.onStateChange?.(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const res = await fetch(`${API_BASE}/v1/runs/${runId}/events?after=${lastSeq}`, {
          credentials: 'include',
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (res.status === 404 || res.status === 401 || res.status === 403) break;
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        opts.onStateChange?.('open');
        attempt = 0;
        for await (const data of readFrames(res.body)) {
          const event = JSON.parse(data) as RunEvent;
          if (event.seq <= lastSeq) continue;
          lastSeq = event.seq;
          opts.onEvent(event);
          if (isTerminalEvent(event)) done = true;
        }
      } catch {
        if (controller.signal.aborted) break;
      }
      if (done || controller.signal.aborted) break;
      attempt++;
      await sleep(Math.min(500 * 2 ** attempt, 8000), controller.signal);
    }
    opts.onStateChange?.('closed');
  };
  void loop();
  return () => controller.abort();
}

async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
