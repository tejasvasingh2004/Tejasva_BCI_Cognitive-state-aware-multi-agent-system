import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths that must never be logged. Model reasoning is never logged because it never leaves the
 * Model Gateway; secrets are redacted here as a last line of defence.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.token',
  '*.authorization',
  'headers.authorization',
];

export function createLogger(service: string, opts: LoggerOptions = {}): Logger {
  const pretty = process.env.LOG_PRETTY === '1' || (process.env.NODE_ENV !== 'production' && process.stdout.isTTY);
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } } : {}),
    ...opts,
  });
}

export type { Logger };
