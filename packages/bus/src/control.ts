import { keys, type Redis } from './redis';

export type ControlMessage =
  | { type: 'cancel'; reason?: string }
  | { type: 'approval'; toolCallId: string; approved: boolean; reason?: string };

const APPROVAL_TTL_S = 3600;

/** API side: sends control messages to whichever worker owns a run. */
export class RunControlPublisher {
  constructor(private readonly redis: Redis) {}

  async cancel(runId: string, reason = 'Cancelled by user'): Promise<void> {
    await this.redis.publish(keys.control(runId), JSON.stringify({ type: 'cancel', reason } satisfies ControlMessage));
  }

  /** Approval decisions are also stored so a worker that subscribes late still sees them. */
  async approval(runId: string, toolCallId: string, approved: boolean, reason?: string): Promise<void> {
    const msg: ControlMessage = { type: 'approval', toolCallId, approved, reason };
    await this.redis.set(keys.approval(runId, toolCallId), JSON.stringify(msg), 'EX', APPROVAL_TTL_S);
    await this.redis.publish(keys.control(runId), JSON.stringify(msg));
  }
}

type Handler = (msg: ControlMessage) => void;

/** Worker side: one pattern subscription dispatching to the runs this worker is executing. */
export class RunControlListener {
  private readonly handlers = new Map<string, Set<Handler>>();
  private started = false;

  constructor(
    private readonly subscriber: Redis,
    private readonly redis: Redis,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      const runId = channel.split(':')[2];
      const set = runId ? this.handlers.get(runId) : undefined;
      if (!set) return;
      try {
        const msg = JSON.parse(message) as ControlMessage;
        for (const h of set) h(msg);
      } catch {
        // ignore malformed control messages
      }
    });
    await this.subscriber.psubscribe(keys.controlPattern);
  }

  on(runId: string, handler: Handler): () => void {
    let set = this.handlers.get(runId);
    if (!set) this.handlers.set(runId, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(runId);
    };
  }

  /** Waits for an approval decision for a tool call, honouring timeout and cancellation. */
  async waitForApproval(
    runId: string,
    toolCallId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ approved: boolean; reason?: string } | 'timeout'> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (v: { approved: boolean; reason?: string } | 'timeout' | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', onAbort);
        if (v instanceof Error) reject(v);
        else resolve(v);
      };
      const off = this.on(runId, (msg) => {
        if (msg.type === 'approval' && msg.toolCallId === toolCallId) finish(msg);
      });
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      // A decision may have been made before we subscribed.
      void this.redis.get(keys.approval(runId, toolCallId)).then((raw) => {
        if (!raw) return;
        const msg = JSON.parse(raw) as ControlMessage;
        if (msg.type === 'approval') finish(msg);
      });
    });
  }
}
