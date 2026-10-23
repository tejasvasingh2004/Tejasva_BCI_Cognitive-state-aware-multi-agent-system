# Webhooks and async runs

NeuroFlow can post events to your server instead of you keeping a stream open: when a run
finishes, fails or is cancelled, when it waits for your approval of a tool call, and when spending
crosses a budget alert or limit.

## Async runs

Start a run with a `webhookUrl`, return immediately, and receive the result when it is ready:

```bash
curl https://api.example.com/v1/runs \
  -H "Authorization: Bearer $NEUROFLOW_API_KEY" -H "Content-Type: application/json" \
  -d '{
        "messages": [{ "role": "user", "content": "Summarise last week'\''s incidents" }],
        "webhookUrl": "https://example.com/hooks/neuroflow",
        "metadata": { "ticket": "OPS-1234" }
      }'
```

The response (`201`) contains the run id. When the run ends, `webhookUrl` receives a
`run.completed` (or `run.failed` / `run.cancelled`) event with the run's output, usage and your
`metadata`. If the run needs approval for a consequential tool call, it receives
`run.approval_requested`; approve or reject with `POST /v1/runs/:id/approvals`. You can also poll
`GET /v1/runs/:id` or stream `GET /v1/runs/:id/events` at any time.

## Endpoints

Register endpoints under **Settings → Webhooks** or with the API (admin scope):

| Method | Path | |
| --- | --- | --- |
| `GET` | `/v1/webhooks` | endpoints, secret hint, event types |
| `POST` | `/v1/webhooks` | `{ url, description?, eventTypes? }` (empty `eventTypes` = all) |
| `PATCH` | `/v1/webhooks/:id` | `{ url?, description?, eventTypes?, enabled? }` |
| `DELETE` | `/v1/webhooks/:id` | |
| `POST` | `/v1/webhooks/:id/test` | sends a `webhook.test` event |
| `GET` | `/v1/webhooks/deliveries`, `/v1/webhooks/:id/deliveries` | delivery log |
| `POST` | `/v1/webhooks/deliveries/:id/retry` | send a finished delivery again |
| `GET` | `/v1/webhooks/secret` | the signing secret (audited) |
| `POST` | `/v1/webhooks/secret/rotate` | new secret; the old one also signs for 24 hours |

Event types: `run.completed`, `run.failed`, `run.cancelled`, `run.approval_requested`,
`budget.threshold_reached`, `budget.exceeded`.

## Payload

```json
{
  "id": "6f1c…",
  "type": "run.completed",
  "timestamp": "2026-10-24T09:30:12.115Z",
  "workspaceId": "…",
  "data": {
    "run": {
      "id": "…", "status": "completed", "conversationId": "…",
      "output": "…", "error": null,
      "usage": { "promptTokens": 812, "completionTokens": 240, "totalTokens": 1052, "costUsd": 0.0031 },
      "toolCalls": null, "metadata": { "ticket": "OPS-1234" },
      "createdAt": "…", "completedAt": "…"
    }
  }
}
```

`run.approval_requested` carries `runId`, `toolCallId`, `name`, `riskLevel`, `reason`, `preview`
and `expiresAt`; budget events carry `scope`, `limitUsd`, `spendUsd` and `period`.

## Verifying signatures

Deliveries follow the [Standard Webhooks](https://www.standardwebhooks.com) specification, so any
Standard Webhooks library verifies them. Each request has:

- `webhook-id`: the delivery id (the same on every retry; use it to ignore duplicates),
- `webhook-timestamp`: Unix seconds,
- `webhook-signature`: one or more space-separated `v1,<base64>` signatures (two during a secret
  rotation).

The signature is HMAC-SHA256 of `"<webhook-id>.<webhook-timestamp>.<raw body>"`, keyed with the
base64-decoded part of your `whsec_…` secret. Verify against the **raw** body and reject
timestamps more than five minutes old.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret: string, headers: Record<string, string>, rawBody: string): boolean {
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = `v1,${createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64')}`;
  return headers['webhook-signature'].split(' ').some(
    (s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)),
  );
}
```

```python
import base64, hashlib, hmac, time

def verify(secret: str, headers: dict, raw_body: bytes) -> bool:
    msg_id, ts = headers["webhook-id"], headers["webhook-timestamp"]
    if abs(time.time() - int(ts)) > 300:
        return False
    key = base64.b64decode(secret.removeprefix("whsec_"))
    digest = hmac.new(key, f"{msg_id}.{ts}.".encode() + raw_body, hashlib.sha256).digest()
    expected = "v1," + base64.b64encode(digest).decode()
    return any(hmac.compare_digest(s, expected) for s in headers["webhook-signature"].split(" "))
```

The SDKs include this as `verifyWebhook` / `verify_webhook`.

## Delivery

- Respond with any `2xx` within 10 seconds; do slow work after responding.
- Failed deliveries are retried after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h and 24 h
  (about two days), then marked failed. Retries keep the same `webhook-id`.
- Redirects are not followed. An endpoint that answers `410 Gone` is switched off.
- Order is not guaranteed across events; use `timestamp` and the run's `status`.
- Destinations must be public `https` URLs: private, loopback, link-local and cloud-metadata
  addresses are refused, also after DNS resolution. (`WEBHOOK_ALLOW_PRIVATE=true` lifts this for
  local development only.)
