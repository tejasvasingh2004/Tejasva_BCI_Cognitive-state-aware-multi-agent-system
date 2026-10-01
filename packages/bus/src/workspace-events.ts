import type { Redis } from './redis';

/** Live, non-persisted events of a code workspace (sync status, user command output, file changes). */
export type WorkspaceEvent = { type: string; data: unknown; ts: string };

const channel = (codeWorkspaceId: string) => `nf:cw:${codeWorkspaceId}`;

export async function publishWorkspaceEvent(redis: Redis, codeWorkspaceId: string, type: string, data: unknown): Promise<void> {
  const event: WorkspaceEvent = { type, data, ts: new Date().toISOString() };
  await redis.publish(channel(codeWorkspaceId), JSON.stringify(event));
}

/** Fans out workspace events from one Redis subscriber connection to many SSE listeners. */
export class WorkspaceEventHub {
  private readonly listeners = new Map<string, Set<(e: WorkspaceEvent) => void>>();

  constructor(private readonly subscriber: Redis) {
    subscriber.on('message', (ch: string, message: string) => {
      if (!ch.startsWith('nf:cw:')) return;
      const set = this.listeners.get(ch.slice(6));
      if (!set) return;
      let event: WorkspaceEvent;
      try {
        event = JSON.parse(message) as WorkspaceEvent;
      } catch {
        return;
      }
      for (const l of set) l(event);
    });
  }

  async follow(codeWorkspaceId: string, onEvent: (e: WorkspaceEvent) => void): Promise<() => Promise<void>> {
    let set = this.listeners.get(codeWorkspaceId);
    if (!set) {
      set = new Set();
      this.listeners.set(codeWorkspaceId, set);
      await this.subscriber.subscribe(channel(codeWorkspaceId));
    }
    set.add(onEvent);
    return async () => {
      const s = this.listeners.get(codeWorkspaceId);
      if (!s) return;
      s.delete(onEvent);
      if (s.size === 0) {
        this.listeners.delete(codeWorkspaceId);
        await this.subscriber.unsubscribe(channel(codeWorkspaceId)).catch(() => {});
      }
    };
  }
}
