import { z } from 'zod';

/**
 * Webhooks: NeuroFlow posts events to customer URLs, signed per the Standard Webhooks
 * specification (https://www.standardwebhooks.com): headers `webhook-id`, `webhook-timestamp` and
 * `webhook-signature` (`v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`), with the workspace's
 * `whsec_` signing secret. Any Standard Webhooks library verifies them.
 */
export const WEBHOOK_EVENT_TYPES = [
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.approval_requested',
  'budget.threshold_reached',
  'budget.exceeded',
] as const;
export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

/** The JSON body of every delivery. `id` is also the `webhook-id` header (stable across retries). */
export type WebhookPayload = {
  id: string;
  type: WebhookEventType | 'webhook.test';
  timestamp: string;
  workspaceId: string;
  data: Record<string, unknown>;
};

export const WebhookUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'Webhook URLs must be http(s) URLs' });

export const CreateWebhookBody = z.object({
  url: WebhookUrl,
  description: z.string().trim().max(200).optional(),
  /** Event types to receive; empty means all. */
  eventTypes: z.array(WebhookEventType).max(WEBHOOK_EVENT_TYPES.length).default([]),
});
export type CreateWebhookBody = z.infer<typeof CreateWebhookBody>;

export const UpdateWebhookBody = z
  .object({
    url: WebhookUrl.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    eventTypes: z.array(WebhookEventType).max(WEBHOOK_EVENT_TYPES.length).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });
export type UpdateWebhookBody = z.infer<typeof UpdateWebhookBody>;

export const WebhookDeliveryStatus = z.enum(['pending', 'delivering', 'delivered', 'failed']);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const WebhookEndpoint = z.object({
  id: z.string().uuid(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(WebhookEventType),
  enabled: z.boolean(),
  /** Why NeuroFlow turned the endpoint off (e.g. it answered 410 Gone). */
  disabledReason: z.string().nullable(),
  createdAt: z.string(),
  lastDelivery: z.object({ status: WebhookDeliveryStatus, statusCode: z.number().nullable(), at: z.string() }).nullable(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

export const WebhookDelivery = z.object({
  id: z.string(),
  endpointId: z.string().nullable(),
  url: z.string(),
  eventType: z.string(),
  runId: z.string().nullable(),
  status: WebhookDeliveryStatus,
  attempts: z.number(),
  nextAttemptAt: z.string().nullable(),
  lastStatusCode: z.number().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

export const WebhooksResponse = z.object({
  endpoints: z.array(WebhookEndpoint),
  /** The signing secret's last four characters; null until the first endpoint or async run creates it. */
  secret: z.object({ hint: z.string(), createdAt: z.string() }).nullable(),
  eventTypes: z.array(WebhookEventType),
  canEdit: z.boolean(),
});
export type WebhooksResponse = z.infer<typeof WebhooksResponse>;
