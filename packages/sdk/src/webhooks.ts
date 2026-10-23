import { WebhookVerificationError } from './errors.js';
import type { WebhookEvent } from './types.js';

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

const header = (h: HeaderSource, name: string): string | undefined => {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()] ?? Object.entries(rec).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(v) ? v[0] : v;
};

const toBytes = (s: string) => new TextEncoder().encode(s);

const base64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToBase64 = (bytes: ArrayBuffer): string => {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Constant-time comparison of two ASCII strings. */
const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** `v1,<base64 HMAC-SHA256("<id>.<timestamp>.<body>")>` (Standard Webhooks). */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base64ToBytes(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, toBytes(`${id}.${timestamp}.${body}`));
  return `v1,${bytesToBase64(mac)}`;
}

/**
 * Verifies a NeuroFlow webhook and returns its parsed event. Pass the **raw** request body exactly
 * as received. Throws `WebhookVerificationError` when the signature or timestamp is wrong.
 *
 * ```ts
 * const event = await verifyWebhook(process.env.NEUROFLOW_WEBHOOK_SECRET!, req.headers, rawBody);
 * if (event.type === 'run.completed') …
 * ```
 */
export async function verifyWebhook(
  secret: string,
  headers: HeaderSource,
  body: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): Promise<WebhookEvent> {
  const id = header(headers, 'webhook-id');
  const ts = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !ts || !signatures) throw new WebhookVerificationError('Missing webhook-id, webhook-timestamp or webhook-signature header');
  const timestamp = Number(ts);
  const now = (opts.now ?? Date.now()) / 1000;
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > (opts.toleranceSeconds ?? 300)) {
    throw new WebhookVerificationError('Webhook timestamp is outside the tolerance window');
  }
  const expected = await signWebhook(secret, id, timestamp, body);
  if (!signatures.split(' ').some((s) => safeEqual(s, expected))) throw new WebhookVerificationError('Webhook signature does not match');
  return JSON.parse(body) as WebhookEvent;
}
