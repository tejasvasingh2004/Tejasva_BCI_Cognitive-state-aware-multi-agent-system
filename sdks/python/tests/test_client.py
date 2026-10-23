import json
import os
import sys
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from neuroflow import NeuroFlow, NeuroFlowError, WebhookVerificationError, sign_webhook, verify_webhook  # noqa: E402


class Script:
    """A local HTTP server answering requests from a list of handlers, in order."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        script = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _handle(self):
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length).decode() if length else None
                call = {"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
                script.calls.append(call)
                status, headers, payload, chunks = script.responses.pop(0)(call)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                if chunks is None:
                    data = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                else:
                    self.end_headers()
                    for c in chunks:
                        self.wfile.write(c.encode())
                        self.wfile.flush()

            do_GET = _handle
            do_POST = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def js(status, body, headers=None):
    return lambda call: (status, {"content-type": "application/json", **(headers or {})}, body, None)


def sse(*chunks):
    return lambda call: (200, {"content-type": "text/event-stream"}, "", list(chunks))


def ev(seq, type_, data=None):
    return f"id: {seq}\nevent: {type_}\ndata: {json.dumps({'runId': 'r1', 'seq': seq, 'ts': 't', 'type': type_, 'data': data or {}})}\n\n"


class ClientTests(unittest.TestCase):
    def serve(self, *responses):
        s = Script(responses)
        self.addCleanup(s.close)
        return s, NeuroFlow(api_key="nf_test", base_url=s.url + "/", max_retries=2)

    def test_retries_with_the_same_idempotency_key(self):
        s, nf = self.serve(
            js(429, {"error": {"code": "rate_limited", "message": "slow"}}, {"retry-after": "0"}),
            js(503, {"error": {"code": "unavailable", "message": "busy"}}, {"retry-after": "0"}),
            js(201, {"run": {"id": "r1"}, "conversationId": "c", "eventsUrl": "/v1/runs/r1/events"}),
        )
        res = nf.runs.create({"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(res["run"]["id"], "r1")
        self.assertEqual(len(s.calls), 3)
        self.assertEqual(s.calls[0]["headers"]["authorization"], "Bearer nf_test")
        keys = {c["headers"]["idempotency-key"] for c in s.calls}
        self.assertEqual(len(keys), 1)
        uuid.UUID(keys.pop())

    def test_client_errors_are_not_retried(self):
        s, nf = self.serve(js(429, {"error": {"code": "quota_exceeded", "message": "Monthly limit reached", "details": {"limitUsd": 5}}}, {"x-request-id": "req-1"}))
        nf.max_retries = 0
        with self.assertRaises(NeuroFlowError) as ctx:
            nf.runs.get("r1")
        err = ctx.exception
        self.assertEqual((err.status, err.code, err.message, err.details, err.request_id), (429, "quota_exceeded", "Monthly limit reached", {"limitUsd": 5}, "req-1"))

        s2, nf2 = self.serve(js(404, {"error": {"code": "not_found", "message": "Run not found"}}))
        with self.assertRaises(NeuroFlowError) as ctx2:
            nf2.runs.get("missing")
        self.assertEqual(ctx2.exception.code, "not_found")
        self.assertEqual(len(s2.calls), 1)

    def test_events_resume_after_a_dropped_stream(self):
        first = ev(1, "run.started") + ev(2, "response.delta", {"text": "Hel"})

        def resumed(call):
            self.assertEqual(call["headers"].get("last-event-id"), "2")
            return (200, {"content-type": "text/event-stream"}, "", [ev(2, "response.delta", {"text": "Hel"}), ev(3, "response.delta", {"text": "lo"}), ev(4, "run.completed", {"durationMs": 1})])

        s, nf = self.serve(sse(first[:30], first[30:], ": ping\n\n"), resumed)
        seen = [f"{e['seq']}:{e['type']}" for e in nf.runs.events("r1")]
        self.assertEqual(seen, ["1:run.started", "2:response.delta", "3:response.delta", "4:run.completed"])

    def test_wait_answers_approvals(self):
        def approval(call):
            self.assertTrue(call["path"].endswith("/v1/runs/r1/approvals"))
            self.assertEqual(json.loads(call["body"]), {"toolCallId": "tc1", "approved": False, "reason": "not now"})
            return (200, {"content-type": "application/json"}, {"ok": True}, None)

        s, nf = self.serve(
            sse(ev(1, "approval.requested", {"toolCallId": "tc1", "name": "commit", "riskLevel": "high", "arguments": {}, "expiresAt": "x"}), ev(2, "run.completed", {"durationMs": 1})),
            approval,
            js(200, {"run": {"id": "r1", "status": "completed", "output": "ok"}}),
        )
        asked = []
        run = nf.runs.wait("r1", on_approval=lambda req: asked.append(req["name"]) or {"approved": False, "reason": "not now"})
        self.assertEqual(run["output"], "ok")
        self.assertEqual(asked, ["commit"])

    def test_stream_yields_text(self):
        s, nf = self.serve(
            js(201, {"run": {"id": "r1"}, "conversationId": "c", "eventsUrl": ""}),
            sse(ev(1, "response.delta", {"text": "Hello "}), ev(2, "response.delta", {"text": "world"}), ev(3, "run.completed", {"durationMs": 1})),
        )
        self.assertEqual("".join(nf.runs.stream({"messages": [{"role": "user", "content": "hi"}]})), "Hello world")

    def test_network_errors_are_reported(self):
        nf = NeuroFlow(api_key="k", base_url="http://127.0.0.1:9", max_retries=0, timeout=2)
        with self.assertRaises(NeuroFlowError) as ctx:
            nf.runs.get("r1")
        self.assertIn(ctx.exception.code, ("network", "timeout"))
        self.assertTrue(ctx.exception.retryable)


class WebhookTests(unittest.TestCase):
    # The Standard Webhooks specification's published test vector (not a real secret); assembled at
    # runtime so secret scanners do not mistake it for a live signing secret.
    secret = "_".join(["whsec", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"])
    body = '{"test": 2432232314}'
    at = 1614265330

    def test_reference_signature(self):
        sig = sign_webhook(self.secret, "msg_p5jXN8AQM9LWM0D4loKWxJek", self.at, self.body)
        self.assertEqual(sig, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=")
        headers = {"Webhook-Id": "msg_p5jXN8AQM9LWM0D4loKWxJek", "Webhook-Timestamp": str(self.at), "Webhook-Signature": f"v1,old {sig}"}
        self.assertEqual(verify_webhook(self.secret, headers, self.body.encode(), now=self.at), {"test": 2432232314})

    def test_rejections(self):
        sig = sign_webhook(self.secret, "m1", self.at, self.body)
        headers = {"webhook-id": "m1", "webhook-timestamp": str(self.at), "webhook-signature": sig}
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(self.secret, headers, '{"test": 1}', now=self.at)
        with self.assertRaisesRegex(WebhookVerificationError, "tolerance"):
            verify_webhook(self.secret, headers, self.body, now=self.at + 600)
        with self.assertRaisesRegex(WebhookVerificationError, "Missing"):
            verify_webhook(self.secret, {}, self.body)


@unittest.skipUnless(os.environ.get("NEUROFLOW_TEST_BASE_URL"), "set NEUROFLOW_TEST_BASE_URL to run against a live NeuroFlow API")
class LiveTests(unittest.TestCase):
    """Against a running stack (e.g. the E2E stack: node --import tsx apps/web/e2e/stack.ts)."""

    def setUp(self):
        self.nf = NeuroFlow(api_key=os.environ.get("NEUROFLOW_TEST_API_KEY") or None, base_url=os.environ["NEUROFLOW_TEST_BASE_URL"])

    def test_run_wait_and_stream(self):
        events = []
        run = self.nf.runs.run({"agentStrategy": "direct", "messages": [{"role": "user", "content": "hello from python"}]}, on_event=lambda e: events.append(e["type"]))
        self.assertEqual(run["status"], "completed")
        self.assertIn("hello from python", run["output"])
        self.assertEqual(events[0], "run.created")
        self.assertEqual(events[-1], "run.completed")
        text = "".join(self.nf.runs.stream({"agentStrategy": "direct", "messages": [{"role": "user", "content": "stream from python"}]}))
        self.assertIn("stream from python", text)

    def test_idempotent_create_and_errors(self):
        key = str(uuid.uuid4())
        a = self.nf.runs.create({"messages": [{"role": "user", "content": "once"}]}, idempotency_key=key)
        b = self.nf.runs.create({"messages": [{"role": "user", "content": "once"}]}, idempotency_key=key)
        self.assertEqual(a["run"]["id"], b["run"]["id"])
        self.nf.runs.wait(a["run"]["id"])
        with self.assertRaises(NeuroFlowError) as ctx:
            self.nf.runs.get(str(uuid.uuid4()))
        self.assertEqual(ctx.exception.status, 404)


if __name__ == "__main__":
    unittest.main()
