import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { REDACT_PATHS } from '../src';

describe('logger redaction', () => {
  it('never writes credentials or secrets', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info(
      {
        req: { headers: { authorization: 'Bearer nf_secret_key', cookie: 'nf_session=abc' } },
        provider: { apiKey: 'gsk_live_123', model: 'qwen3:8b' },
        user: { password: 'hunter2' },
      },
      'request',
    );
    const out = lines.join('');
    expect(out).not.toContain('nf_secret_key');
    expect(out).not.toContain('gsk_live_123');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('nf_session=abc');
    expect(out).toContain('qwen3:8b');
  });
});
