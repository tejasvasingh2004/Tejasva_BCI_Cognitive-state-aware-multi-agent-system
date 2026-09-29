import type { FastifyReply, FastifyRequest } from 'fastify';

export type SseWriter = {
  send(event: { id?: number | string; event?: string; data: unknown }): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
  onClose(fn: () => void): void;
};

/**
 * Opens a Server-Sent Events stream on a hijacked reply. Headers already set by hooks (CORS,
 * request id) are preserved. Heartbeats keep proxies from closing idle streams.
 */
export function openSse(req: FastifyRequest, reply: FastifyReply, heartbeatMs = 15_000): SseWriter {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.flushHeaders?.();

  let closed = false;
  const closeHandlers: Array<() => void> = [];
  const heartbeat = setInterval(() => !closed && raw.write(': ping\n\n'), heartbeatMs);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of closeHandlers) fn();
  };
  req.raw.on('close', finish);

  return {
    send({ id, event, data }) {
      if (closed) return;
      let chunk = '';
      if (id !== undefined) chunk += `id: ${id}\n`;
      if (event) chunk += `event: ${event}\n`;
      chunk += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
      raw.write(chunk);
    },
    comment(text) {
      if (!closed) raw.write(`: ${text}\n\n`);
    },
    close() {
      if (closed) return;
      finish();
      raw.end();
    },
    get closed() {
      return closed;
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
  };
}
