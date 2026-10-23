# @neuroflow/sdk

TypeScript client for the [NeuroFlow](../../README.md) API: start runs, stream their events and
answer, approve tool calls, and verify webhooks. No dependencies; works in Node 18+, Bun, Deno and
browsers (anything with `fetch` and Web Crypto).

```bash
npm install @neuroflow/sdk
```

## Quick start

```ts
import { NeuroFlow } from '@neuroflow/sdk';

const nf = new NeuroFlow({ apiKey: process.env.NEUROFLOW_API_KEY, baseUrl: 'https://api.example.com' });

const run = await nf.runs.run({ messages: [{ role: 'user', content: 'Draft a launch checklist' }] });
console.log(run.output, run.usage);
```

`apiKey` and `baseUrl` default to the `NEUROFLOW_API_KEY` and `NEUROFLOW_BASE_URL` environment
variables.

## Streaming

```ts
const stream = nf.runs.stream({ messages: [{ role: 'user', content: 'Explain envelope encryption' }] });
for await (const text of stream) process.stdout.write(text);
```

Every execution event (router decision, agents, model and tool calls, approvals, deltas):

```ts
const { run } = await nf.runs.create({ messages, agentStrategy: 'supervisor' });
for await (const event of nf.runs.events(run.id)) {
  if (event.type === 'tool.completed') console.log('tool', event.data);
}
```

A dropped connection resumes from the last event received (`Last-Event-ID`), so nothing is
missed or repeated.

## Approvals

Consequential tool calls wait for a decision. Answer them in code:

```ts
const run = await nf.runs.run(request, {
  onApproval: async (req) => (req.riskLevel === 'high' ? { approved: false, reason: 'needs a human' } : { approved: true }),
});
```

or later with `nf.runs.approve(runId, { toolCallId, approved: true })`, for example from a
`run.approval_requested` webhook.

## Async runs and webhooks

```ts
const { run } = await nf.runs.create({ messages, webhookUrl: 'https://example.com/hooks/neuroflow' });
```

Verify deliveries with the raw request body:

```ts
import { verifyWebhook } from '@neuroflow/sdk';

app.post('/hooks/neuroflow', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = await verifyWebhook(process.env.NEUROFLOW_WEBHOOK_SECRET!, req.headers, req.body.toString());
  if (event.type === 'run.completed') console.log(event.data.run);
  res.sendStatus(204);
});
```

See [docs/WEBHOOKS.md](../../docs/WEBHOOKS.md) for event types and payloads.

## Reliability

- Rate limits (`429`), server errors (`5xx`), timeouts and network failures are retried
  (`maxRetries`, default 2) with exponential backoff, honouring `Retry-After`.
- `runs.create` always sends an `Idempotency-Key` (generated unless you pass one), so a retried
  create returns the same run instead of starting a second one.
- Errors are `NeuroFlowError` with `status`, `code` (e.g. `quota_exceeded`, `not_found`),
  `details`, `retryAfterMs` and `requestId`.

| Method | |
| --- | --- |
| `runs.create(request, { idempotencyKey? })` | start a run, return at once |
| `runs.get(id)` / `runs.cancel(id)` | read or cancel |
| `runs.events(id, { after? })` | async iterator of events until the run ends |
| `runs.wait(id, { onEvent?, onApproval? })` | follow a run and return the final run |
| `runs.run(request, …)` | `create` + `wait` |
| `runs.stream(request, …)` | answer text chunks, then the final run |
| `runs.approve(id, { toolCallId, approved, reason? })` | decide a pending approval |
| `verifyWebhook(secret, headers, body)` | verify and parse a webhook |
