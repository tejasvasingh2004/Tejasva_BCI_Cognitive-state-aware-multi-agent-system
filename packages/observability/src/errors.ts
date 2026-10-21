import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Logger } from './logger';

/**
 * Error tracking. Reports unexpected errors to a Sentry-compatible endpoint through its HTTP
 * envelope API — no SDK, so it does not install a second OpenTelemetry pipeline next to ours.
 * Disabled (a no-op) unless a DSN is configured. Never sends request bodies, prompts, model
 * output or headers, and redacts credentials from messages and stack traces.
 */
export type ErrorContext = {
  level?: 'fatal' | 'error' | 'warning';
  /** Short, low-cardinality labels (route, stage, error code). */
  tags?: Record<string, string | number | boolean | undefined>;
  /** Identifiers that help find the event in logs (run id, request id). */
  extra?: Record<string, string | number | boolean | null | undefined>;
};

export type ErrorReporter = {
  readonly enabled: boolean;
  capture(err: unknown, ctx?: ErrorContext): void;
  /** Waits for in-flight reports (shutdown). */
  flush(timeoutMs?: number): Promise<void>;
};

export const noopErrorReporter: ErrorReporter = { enabled: false, capture: () => {}, flush: async () => {} };

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  [/\b(sk|gsk|nf)_[A-Za-z0-9_-]{8,}/g, '$1_[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh_[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_[redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@]+@/gi, '$1[redacted]@'],
  [/([?&](?:key|token|secret|password|api_key|access_token)=)[^&\s]+/gi, '$1[redacted]'],
];

/** Removes credentials (tokens, API keys, passwords in URLs) from free text. */
export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

type Frame = { function?: string; filename?: string; lineno?: number; colno?: number; in_app: boolean };

/** V8 stack → Sentry frames (oldest call first). */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n').slice(1, 51)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const filename = redact(m[2]!);
    frames.push({
      ...(m[1] ? { function: m[1] } : {}),
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.reverse();
}

function exceptions(err: unknown) {
  const chain: Array<{ type: string; value: string; stacktrace?: { frames: Frame[] } }> = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 4; depth++) {
    const e = cur instanceof Error ? cur : new Error(typeof cur === 'string' ? cur : 'Non-error value thrown');
    const frames = parseStack(e.stack);
    chain.push({ type: e.name || 'Error', value: redact(e.message).slice(0, 1000), ...(frames.length ? { stacktrace: { frames } } : {}) });
    cur = (e as { cause?: unknown }).cause;
  }
  // Sentry lists chained exceptions root cause first.
  return chain.reverse();
}

/** `https://<key>@<host>[/path]/<project>` → envelope endpoint and public key. */
export function parseDsn(dsn: string): { endpoint: string; publicKey: string } {
  const url = new URL(dsn);
  const project = url.pathname.split('/').filter(Boolean).pop();
  if (!url.username || !project) throw new Error('Invalid SENTRY_DSN');
  const prefix = url.pathname.slice(0, url.pathname.lastIndexOf('/'));
  return { endpoint: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`, publicKey: url.username };
}

export type ErrorReporterOptions = {
  dsn?: string;
  service: string;
  environment?: string;
  release?: string;
  logger?: Logger;
  /** Events per minute per process; the rest are dropped (an error storm must not become a bill). */
  maxPerMinute?: number;
  /** Identical errors (type + message + top frame) are reported once per window. */
  dedupeWindowMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

export function createErrorReporter(opts: ErrorReporterOptions): ErrorReporter {
  if (!opts.dsn) return noopErrorReporter;
  let target: { endpoint: string; publicKey: string };
  try {
    target = parseDsn(opts.dsn);
  } catch {
    opts.logger?.warn('SENTRY_DSN is invalid; error tracking disabled');
    return noopErrorReporter;
  }
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const maxPerMinute = opts.maxPerMinute ?? 30;
  const dedupeWindowMs = opts.dedupeWindowMs ?? 60_000;
  const recent = new Map<string, number>();
  let windowStart = now();
  let sentInWindow = 0;
  const pending = new Set<Promise<void>>();

  const capture = (err: unknown, ctx: ErrorContext = {}) => {
    try {
      const values = exceptions(err);
      const top = values.at(-1)!;
      const fingerprint = `${top.type}|${top.value.split('\n')[0]}|${top.stacktrace?.frames.at(-1)?.filename ?? ''}:${top.stacktrace?.frames.at(-1)?.lineno ?? ''}`;
      const t = now();
      if ((recent.get(fingerprint) ?? -Infinity) > t - dedupeWindowMs) return;
      if (t - windowStart >= 60_000) {
        windowStart = t;
        sentInWindow = 0;
      }
      if (sentInWindow >= maxPerMinute) return;
      sentInWindow++;
      recent.set(fingerprint, t);
      if (recent.size > 500) recent.delete(recent.keys().next().value!);

      const eventId = randomUUID().replace(/-/g, '');
      const clean = <T extends Record<string, unknown>>(o: T | undefined) =>
        Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? redact(v).slice(0, 200) : v]));
      const event = {
        event_id: eventId,
        timestamp: t / 1000,
        platform: 'node',
        level: ctx.level ?? 'error',
        logger: opts.service,
        server_name: hostname(),
        ...(opts.environment ? { environment: opts.environment } : {}),
        ...(opts.release ? { release: opts.release } : {}),
        tags: { service: opts.service, ...clean(ctx.tags) },
        extra: clean(ctx.extra),
        exception: { values },
      };
      const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date(t).toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
      const p = doFetch(target.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=neuroflow/1.0`,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      })
        .then((res) => {
          if (!res.ok) opts.logger?.warn({ status: res.status }, 'error report rejected');
        })
        .catch((e: unknown) => opts.logger?.warn({ err: e }, 'error report failed'))
        .finally(() => pending.delete(p));
      pending.add(p);
    } catch (e) {
      // Reporting must never throw into the code that is handling an error.
      opts.logger?.warn({ err: e }, 'error report could not be built');
    }
  };

  return {
    enabled: true,
    capture,
    async flush(timeoutMs = 2_000) {
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
    },
  };
}

/** Reports crashes the process would otherwise only log, then lets the default behaviour continue. */
export function reportProcessErrors(reporter: ErrorReporter, logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
    reporter.capture(reason, { level: 'error', tags: { kind: 'unhandledRejection' } });
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    reporter.capture(err, { level: 'fatal', tags: { kind: 'uncaughtException' } });
    void reporter.flush(2_000).finally(() => process.exit(1));
  });
}
