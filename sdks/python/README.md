# neuroflow (Python)

Python client for the NeuroFlow API: start runs, stream their events and answer, approve tool
calls, and verify webhooks. Standard library only; Python 3.9+.

```bash
pip install neuroflow
```

## Quick start

```python
from neuroflow import NeuroFlow

nf = NeuroFlow(api_key="nf_...", base_url="https://api.example.com")

run = nf.runs.run({"messages": [{"role": "user", "content": "Draft a launch checklist"}]})
print(run["output"], run["usage"])
```

`api_key` and `base_url` default to the `NEUROFLOW_API_KEY` and `NEUROFLOW_BASE_URL` environment
variables.

## Streaming

```python
for text in nf.runs.stream({"messages": [{"role": "user", "content": "Explain envelope encryption"}]}):
    print(text, end="", flush=True)
```

Every execution event:

```python
created = nf.runs.create({"messages": messages, "agentStrategy": "supervisor"})
for event in nf.runs.events(created["run"]["id"]):
    print(event["seq"], event["type"])
```

A dropped connection resumes from the last event received, so nothing is missed or repeated.

## Approvals

```python
def decide(request):
    if request["riskLevel"] == "high":
        return {"approved": False, "reason": "needs a human"}
    return {"approved": True}

run = nf.runs.run(request, on_approval=decide)
```

or later: `nf.runs.approve(run_id, tool_call_id, approved=True)`.

## Async runs and webhooks

```python
nf.runs.create({"messages": messages, "webhookUrl": "https://example.com/hooks/neuroflow"})
```

```python
from neuroflow import verify_webhook, WebhookVerificationError

@app.post("/hooks/neuroflow")          # Flask
def hook():
    try:
        event = verify_webhook(os.environ["NEUROFLOW_WEBHOOK_SECRET"], request.headers, request.get_data())
    except WebhookVerificationError:
        return "", 400
    if event["type"] == "run.completed":
        print(event["data"]["run"]["output"])
    return "", 204
```

Pass the raw body. See [docs/WEBHOOKS.md](../../docs/WEBHOOKS.md) for event types and payloads.

## Reliability

- Rate limits (`429`), server errors (`5xx`), timeouts and network failures are retried
  (`max_retries`, default 2) with exponential backoff, honouring `Retry-After`.
- `runs.create` always sends an `Idempotency-Key` (generated unless you pass `idempotency_key`),
  so a retried create returns the same run.
- Errors are `NeuroFlowError` with `status`, `code` (e.g. `quota_exceeded`), `details`,
  `retry_after` and `request_id`.

## Tests

```bash
python -m unittest discover -s tests            # unit tests against a local mock server
NEUROFLOW_TEST_BASE_URL=http://127.0.0.1:8090 NEUROFLOW_TEST_API_KEY=nf_... \
  python -m unittest tests.test_client.LiveTests # against a running NeuroFlow API
```
