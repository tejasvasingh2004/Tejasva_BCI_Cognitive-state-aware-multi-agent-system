import type { RunEvent, RunEventPayload, RunEventType } from '@neuroflow/contracts';
import { isTerminalEvent } from '@neuroflow/contracts';
import { runEventsRepo, type Queryable } from '@neuroflow/db';
import { keys, type Redis } from './redis';

export interface RunEventSink {
  emit<T extends RunEventType>(type: T, data: RunEventPayload<T>): void;
  /** Waits until everything emitted so far is persisted and published. */
  flush(): Promise<void>;
}

export type RunEmitterOptions = {
  db: Queryable;
  redis: Redis;
  runId: string;
  /** Last persisted sequence number (continue numbering after a recovered attempt). */
  startSeq: number;
  /** Response deltas are coalesced for this long before being persisted/published. */
  deltaFlushMs?: number;
  onError?: (err: unknown) => void;
};

/**
 * Emits run events in order. Each event is persisted to Postgres *before* it is published on
 * Redis, so a subscriber that replays from the database and then follows the live channel can
 * never miss an event. Token deltas are coalesced to bound write volume.
 */
export class RunEventEmitter implements RunEventSink {
  private seq: number;
  private chain: Promise<void> = Promise.resolve();
  private pendingDelta = '';
  private deltaTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly deltaFlushMs: number;

  constructor(private readonly opts: RunEmitterOptions) {
    this.seq = opts.startSeq;
    this.deltaFlushMs = opts.deltaFlushMs ?? 60;
  }

  emit<T extends RunEventType>(type: T, data: RunEventPayload<T>): void {
    if (type === 'response.delta') {
      this.pendingDelta += (data as RunEventPayload<'response.delta'>).text;
      this.deltaTimer ??= setTimeout(() => this.flushDelta(), this.deltaFlushMs);
      return;
    }
    this.flushDelta();
    this.enqueue(type, data);
  }

  async flush(): Promise<void> {
    this.flushDelta();
    await this.chain;
  }

  private flushDelta() {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = undefined;
    }
    if (!this.pendingDelta) return;
    const text = this.pendingDelta;
    this.pendingDelta = '';
    this.enqueue('response.delta', { text });
  }

  private enqueue<T extends RunEventType>(type: T, data: RunEventPayload<T>) {
    const event = { runId: this.opts.runId, seq: ++this.seq, ts: new Date().toISOString(), type, data } as RunEvent;
    this.chain = this.chain.then(async () => {
      try {
        await runEventsRepo.append(this.opts.db, [event]);
        await this.opts.redis.publish(keys.events(event.runId), JSON.stringify(event));
      } catch (err) {
        this.opts.onError?.(err);
      }
    });
  }
}

type Listener = (event: RunEvent) => void;

/**
 * Fan-out of live run events inside one API process: a single Redis subscriber connection serves
 * every SSE/WebSocket client.
 */
export class RunEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly subscriber: Redis,
    private readonly db: Queryable,
  ) {
    subscriber.on('message', (channel: string, message: string) => {
      const runId = channel.split(':')[2];
      if (!runId) return;
      const set = this.listeners.get(runId);
      if (!set) return;
      let event: RunEvent;
      try {
        event = JSON.parse(message) as RunEvent;
      } catch {
        return;
      }
      for (const l of set) l(event);
    });
  }

  /**
   * Streams a run's events after `afterSeq`: persisted history first, then live events, without
   * gaps or duplicates. `onEvent` stops being called after a terminal event.
   */
  async follow(runId: string, afterSeq: number, onEvent: (e: RunEvent) => void): Promise<() => Promise<void>> {
    let last = afterSeq;
    let replaying = true;
    let done = false;
    const buffer: RunEvent[] = [];

    const deliver = (e: RunEvent) => {
      if (done || e.seq <= last) return;
      last = e.seq;
      onEvent(e);
      if (isTerminalEvent(e)) done = true;
    };
    const listener: Listener = (e) => (replaying ? buffer.push(e) : deliver(e));

    await this.add(runId, listener);
    // Subscribe first, then replay: anything published during the replay is buffered.
    let page: RunEvent[];
    do {
      page = await runEventsRepo.list(this.db, runId, last, 1000);
      for (const e of page) deliver(e);
    } while (page.length === 1000 && !done);
    replaying = false;
    buffer.sort((a, b) => a.seq - b.seq).forEach(deliver);
    buffer.length = 0;

    return async () => {
      done = true;
      await this.remove(runId, listener);
    };
  }

  private async add(runId: string, l: Listener) {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
      await this.subscriber.subscribe(keys.events(runId));
    }
    set.add(l);
  }

  private async remove(runId: string, l: Listener) {
    const set = this.listeners.get(runId);
    if (!set) return;
    set.delete(l);
    if (set.size === 0) {
      this.listeners.delete(runId);
      await this.subscriber.unsubscribe(keys.events(runId)).catch(() => {});
    }
  }
}
