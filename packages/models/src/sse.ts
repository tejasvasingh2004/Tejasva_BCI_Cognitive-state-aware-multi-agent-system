/** Parses a `text/event-stream` body into `data:` payloads (one string per event). */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = findBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^(\r?\n){2}/, '');
        const data = extractData(raw);
        if (data !== undefined) yield data;
      }
    }
    buffer += decoder.decode();
    const data = extractData(buffer);
    if (data !== undefined && data.length > 0) yield data;
  } finally {
    reader.releaseLock();
  }
}

function findBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function extractData(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (lines.length === 0) return undefined;
  return lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
}
