const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Removes `<think>…</think>` blocks from streamed content. Some Qwen deployments inline their
 * private reasoning in the content channel; it must never reach users, logs or persisted output.
 * Tags may be split across chunks, so partial tag prefixes are held back until resolved.
 */
export class ThinkFilter {
  private inThink = false;
  private pending = '';

  push(chunk: string): string {
    let input = this.pending + chunk;
    this.pending = '';
    let out = '';
    while (input.length > 0) {
      if (this.inThink) {
        const end = input.indexOf(CLOSE);
        if (end === -1) {
          this.pending = partialSuffix(input, CLOSE);
          return out;
        }
        input = input.slice(end + CLOSE.length);
        this.inThink = false;
        continue;
      }
      const start = input.indexOf(OPEN);
      if (start === -1) {
        const hold = partialSuffix(input, OPEN);
        out += input.slice(0, input.length - hold.length);
        this.pending = hold;
        return out;
      }
      out += input.slice(0, start);
      input = input.slice(start + OPEN.length);
      this.inThink = true;
    }
    return out;
  }

  /** Flushes held-back text at end of stream. An unterminated think block is discarded. */
  flush(): string {
    const rest = this.inThink ? '' : this.pending;
    this.pending = '';
    return rest;
  }
}

function partialSuffix(text: string, tag: string): string {
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) return text.slice(text.length - len);
  }
  return '';
}

export function stripThinking(text: string): string {
  const f = new ThinkFilter();
  return (f.push(text) + f.flush()).replace(/^\s+/, '');
}
