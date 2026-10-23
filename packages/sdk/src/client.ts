import { NeuroFlowError } from './errors.js';
import { verifyWebhook } from './webhooks.js';
import {
  TERMINAL_EVENTS,
  type ApprovalDecision,
  type ApprovalRequest,
  type CreateRunResponse,
  type Run,
  type RunEvent,
  type RunRequest,
} from './types.js';

export type NeuroFlowOptions = {
  /** API key (`nf_…`). Defaults to the `NEUROFLOW_API_KEY` environment variable. */
  apiKey?: string;
  /** API base URL. Defaults to `NEUROFLOW_BASE_URL`, then `http://localhost:8080`. */
  baseUrl?: string;
  /** Retries for rate limits, server errors and network failures (default 2). */
  maxRetries?: number;
  /** Per-request timeout in ms (default 60 s). Event streams are not limited by it. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
};

type RequestOptions = { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; retry?: boolean; query?: Record<string, string | number | undefined> };

/** Environment variables where the runtime has them (Node, Bun, Deno with --allow-env). */
const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
const isTerminal = (type: string) => (TERMINAL_EVENTS as readonly string[]).includes(type);

/**
 * Client for the NeuroFlow API.
 *
 * ```ts
 * const nf = new NeuroFlow({ apiKey: process.env.NEUROFLOW_API_KEY });
 * const run = await nf.runs.run({ messages: [{ role: 'user', content: 'Plan a launch checklist' }] });
 * console.log(run.output);
 * ```
 */
export class NeuroFlow {
  readonly baseUrl: string;
  readonly runs: Runs;
  readonly webhooks = { verify: verifyWebhook };
  private readonly apiKey?: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: NeuroFlowOptions = {}) {
    this.apiKey = opts.apiKey ?? env('NEUROFLOW_API_KEY');
    this.baseUrl = (opts.baseUrl ?? env('NEUROFLOW_BASE_URL') ?? 'http://localhost:8080').replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.extraHeaders = opts.headers ?? {};
    this.runs = new Runs(this);
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const u = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      accept: 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extraHeaders,
      ...extra,
    };
  }

  /** A JSON request with timeouts and bounded retries (exponential backoff, honouring Retry-After). */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const retries = opts.retry === false ? 0 : this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, opts);
      } catch (err) {
        if (!(err instanceof NeuroFlowError) || !err.retryable || attempt >= retries || opts.signal?.aborted) throw err;
        const backoff = Math.min(8_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        await sleep(Math.min(err.retryAfterMs ?? backoff, 60_000), opts.signal);
      }
    }
  }

  private async once<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), {
        method,
        headers: this.headers({ ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers }),
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const timedOut = timeout.aborted;
      throw new NeuroFlowError(timedOut ? `Request timed out after ${this.timeoutMs} ms` : `Network error: ${(err as Error).message}`, {
        code: timedOut ? 'timeout' : 'network',
        cause: err,
      });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) throw toError(res, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Opens an SSE stream (no timeout, no retries; `Runs.events` resumes it). */
  async openStream(path: string, opts: { query?: RequestOptions['query']; lastEventId?: number; signal?: AbortSignal }): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), {
        headers: this.headers({ accept: 'text/event-stream', ...(opts.lastEventId ? { 'last-event-id': String(opts.lastEventId) } : {}) }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new NeuroFlowError(`Network error: ${(err as Error).message}`, { code: 'network', cause: err });
    }
    if (!res.ok || !res.body) throw toError(res, await res.text().catch(() => ''));
    return res;
  }
}

function toError(res: Response, text: string): NeuroFlowError {
  let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  return new NeuroFlowError(body.error?.message ?? `HTTP ${res.status}`, {
    status: res.status,
    code: body.error?.code ?? `http_${res.status}`,
    details: body.error?.details,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    ...(res.headers.get('x-request-id') ? { requestId: res.headers.get('x-request-id')! } : {}),
  });
}

/** Parses an SSE body into events; comments (heartbeats) are skipped. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
        const msg: { id?: string; event?: string; data: string } = { data: '' };
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue;
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'data') data.push(value);
          else if (field === 'id') msg.id = value;
          else if (field === 'event') msg.event = value;
        }
        if (data.length) yield { ...msg, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type WaitOptions = {
  signal?: AbortSignal;
  /** Every event as it arrives (deltas, tool calls, approvals …). */
  onEvent?: (event: RunEvent) => void;
  /**
   * Called when the run needs approval for a tool call. Return a decision to answer it, or
   * undefined to leave it to someone else (the run waits until the approval expires).
   */
  onApproval?: (request: ApprovalRequest) => Promise<Omit<ApprovalDecision, 'toolCallId'> | undefined> | Omit<ApprovalDecision, 'toolCallId'> | undefined;
};

export class Runs {
  constructor(private readonly client: NeuroFlow) {}

  /**
   * Starts a run and returns at once (it executes in a worker). Retries are safe: every create
   * carries an idempotency key (generated unless given), so a retried request returns the same run.
   */
  create(request: RunRequest, opts: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<CreateRunResponse> {
    return this.client.request('POST', '/v1/runs', {
      body: request,
      headers: { 'idempotency-key': opts.idempotencyKey ?? crypto.randomUUID() },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  async get(id: string, opts: { signal?: AbortSignal } = {}): Promise<Run> {
    return (await this.client.request<{ run: Run }>('GET', `/v1/runs/${encodeURIComponent(id)}`, opts)).run;
  }

  async cancel(id: string): Promise<Run> {
    return (await this.client.request<{ run: Run }>('POST', `/v1/runs/${encodeURIComponent(id)}/cancel`)).run;
  }

  /** Approves or rejects a tool call the run is waiting on. */
  async approve(id: string, decision: ApprovalDecision): Promise<void> {
    await this.client.request('POST', `/v1/runs/${encodeURIComponent(id)}/approvals`, { body: decision, retry: false });
  }

  /**
   * The run's events in order, from the beginning (or after `after`), until it ends. A dropped
   * connection is resumed from the last event received, so no event is missed or repeated.
   */
  async *events(id: string, opts: { after?: number; signal?: AbortSignal; maxReconnects?: number } = {}): AsyncGenerator<RunEvent> {
    let last = opts.after ?? 0;
    let failures = 0;
    for (;;) {
      try {
        const res = await this.client.openStream(`/v1/runs/${encodeURIComponent(id)}/events`, {
          ...(last ? { lastEventId: last } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        for await (const msg of readSse(res.body!)) {
          const event = JSON.parse(msg.data) as RunEvent;
          if (event.seq <= last) continue;
          last = event.seq;
          failures = 0;
          yield event;
          if (isTerminal(event.type)) return;
        }
      } catch (err) {
        if (opts.signal?.aborted || (err instanceof NeuroFlowError && err.status !== undefined && !err.retryable)) throw err;
      }
      // The stream ended without a terminal event (connection lost): the run may still be going.
      if (++failures > (opts.maxReconnects ?? 5)) throw new NeuroFlowError('Event stream kept disconnecting', { code: 'network' });
      // Reconnecting with Last-Event-ID replays what was missed, including a terminal event.
      await sleep(Math.min(8_000, 250 * 2 ** failures), opts.signal);
    }
  }

  /** Follows a run until it ends and returns the final run (output, usage, error). */
  async wait(id: string, opts: WaitOptions = {}): Promise<Run> {
    for await (const event of this.events(id, opts.signal ? { signal: opts.signal } : {})) {
      opts.onEvent?.(event);
      if (event.type === 'approval.requested' && opts.onApproval) {
        const data = event.data as ApprovalRequest;
        const decision = await opts.onApproval({ ...data, runId: id });
        if (decision) await this.approve(id, { toolCallId: data.toolCallId, ...decision });
      }
    }
    return this.get(id, opts.signal ? { signal: opts.signal } : {});
  }

  /** Starts a run and waits for it: `create` + `wait`. */
  async run(request: RunRequest, opts: WaitOptions & { idempotencyKey?: string } = {}): Promise<Run> {
    const { run } = await this.create(request, { ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    return this.wait(run.id, opts);
  }

  /**
   * The answer's text as it streams: yields each `response.delta` chunk, then returns the final run.
   * If the answer restarts (a `response.reset` event, e.g. after a provider fallback) the final run's
   * `output` is authoritative; use `events()` to handle resets yourself.
   */
  async *stream(request: RunRequest, opts: Omit<WaitOptions, 'onEvent'> = {}): AsyncGenerator<string, Run> {
    const { run } = await this.create(request, opts.signal ? { signal: opts.signal } : {});
    for await (const event of this.events(run.id, opts.signal ? { signal: opts.signal } : {})) {
      if (event.type === 'response.delta') yield (event.data as { text: string }).text;
      else if (event.type === 'approval.requested' && opts.onApproval) {
        const data = event.data as ApprovalRequest;
        const decision = await opts.onApproval({ ...data, runId: run.id });
        if (decision) await this.approve(run.id, { toolCallId: data.toolCallId, ...decision });
      }
    }
    return this.get(run.id);
  }
}
