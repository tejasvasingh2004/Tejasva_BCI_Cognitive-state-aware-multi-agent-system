from __future__ import annotations

import json
import os
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterator, Mapping, Optional

from ._errors import NeuroFlowError
from .webhooks import verify_webhook

TERMINAL_EVENTS = ("run.completed", "run.failed", "run.cancelled")

#: ``on_approval`` returns ``{"approved": bool, "reason": str}`` to answer, or ``None`` to leave it.
ApprovalHandler = Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]


class NeuroFlow:
    """Client for the NeuroFlow API.

    >>> nf = NeuroFlow(api_key="nf_...", base_url="https://api.example.com")
    >>> run = nf.runs.run({"messages": [{"role": "user", "content": "Draft a launch checklist"}]})
    >>> print(run["output"])

    ``api_key`` and ``base_url`` default to ``NEUROFLOW_API_KEY`` and ``NEUROFLOW_BASE_URL``.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.api_key = api_key or os.environ.get("NEUROFLOW_API_KEY")
        self.base_url = (base_url or os.environ.get("NEUROFLOW_BASE_URL") or "http://localhost:8080").rstrip("/")
        self.max_retries = max_retries
        self.timeout = timeout
        self._headers = dict(headers or {})
        self.runs = Runs(self)

    # -- transport ----------------------------------------------------------------------------

    def _url(self, path: str, query: Optional[Mapping[str, Any]] = None) -> str:
        url = f"{self.base_url}{path}"
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        return url

    def _build(self, method: str, path: str, body: Any = None, headers: Optional[Mapping[str, str]] = None, accept: str = "application/json") -> urllib.request.Request:
        h = {"accept": accept, "user-agent": "neuroflow-python/0.1", **self._headers, **(headers or {})}
        if self.api_key:
            h["authorization"] = f"Bearer {self.api_key}"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["content-type"] = "application/json"
        return urllib.request.Request(self._url(path), data=data, headers=h, method=method)

    def request(self, method: str, path: str, *, body: Any = None, headers: Optional[Mapping[str, str]] = None, retry: bool = True) -> Any:
        """A JSON request with a timeout and bounded retries (exponential backoff, honouring Retry-After)."""
        attempts = self.max_retries if retry else 0
        attempt = 0
        while True:
            try:
                return self._once(method, path, body, headers)
            except NeuroFlowError as err:
                if not err.retryable or attempt >= attempts:
                    raise
                backoff = min(8.0, 0.5 * 2**attempt) * (0.75 + random.random() * 0.5)
                time.sleep(min(err.retry_after if err.retry_after is not None else backoff, 60.0))
                attempt += 1

    def _once(self, method: str, path: str, body: Any, headers: Optional[Mapping[str, str]]) -> Any:
        req = self._build(method, path, body, headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raise _to_error(err.code, err.read(), err.headers) from None
        except (socket.timeout, TimeoutError) as err:
            raise NeuroFlowError(f"Request timed out after {self.timeout} s", code="timeout") from err
        except urllib.error.URLError as err:
            if isinstance(err.reason, (socket.timeout, TimeoutError)):
                raise NeuroFlowError(f"Request timed out after {self.timeout} s", code="timeout") from err
            raise NeuroFlowError(f"Network error: {err.reason}", code="network") from err

    def _stream(self, path: str, last_event_id: int) -> Iterator[Dict[str, str]]:
        """Yields SSE messages (``id``, ``event``, ``data``); heartbeats are skipped."""
        headers = {"last-event-id": str(last_event_id)} if last_event_id else {}
        req = self._build("GET", path, headers=headers, accept="text/event-stream")
        try:
            # Heartbeats arrive every 15 s; a much longer silence means the connection is gone.
            res = urllib.request.urlopen(req, timeout=max(self.timeout, 60.0))
        except urllib.error.HTTPError as err:
            raise _to_error(err.code, err.read(), err.headers) from None
        except (urllib.error.URLError, socket.timeout, TimeoutError) as err:
            raise NeuroFlowError(f"Network error: {err}", code="network") from err
        with res:
            msg: Dict[str, str] = {}
            data: list = []
            for raw in res:
                line = raw.decode("utf-8").rstrip("\r\n")
                if not line:
                    if data:
                        yield {**msg, "data": "\n".join(data)}
                    msg, data = {}, []
                    continue
                if line.startswith(":"):
                    continue
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "data":
                    data.append(value)
                elif field in ("id", "event"):
                    msg[field] = value

    # -- webhooks -----------------------------------------------------------------------------

    @staticmethod
    def verify_webhook(secret: str, headers: Mapping[str, Any], body: Any, **kwargs: Any) -> dict:
        return verify_webhook(secret, headers, body, **kwargs)


def _to_error(status: int, raw: bytes, headers: Any) -> NeuroFlowError:
    try:
        error = json.loads(raw or b"{}").get("error", {})
    except (ValueError, AttributeError):
        error = {}
    retry_after = None
    try:
        value = headers.get("retry-after") if headers is not None else None
        retry_after = float(value) if value else None
    except ValueError:
        pass
    return NeuroFlowError(
        error.get("message") or f"HTTP {status}",
        code=error.get("code") or f"http_{status}",
        status=status,
        details=error.get("details"),
        retry_after=retry_after,
        request_id=headers.get("x-request-id") if headers is not None else None,
    )


class Runs:
    def __init__(self, client: NeuroFlow) -> None:
        self._client = client

    def create(self, request: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Starts a run and returns at once (``{"run", "conversationId", "eventsUrl"}``).

        Every create carries an ``Idempotency-Key`` (generated unless given), so retries are safe.
        """
        return self._client.request("POST", "/v1/runs", body=dict(request), headers={"idempotency-key": idempotency_key or str(uuid.uuid4())})

    def get(self, run_id: str) -> Dict[str, Any]:
        return self._client.request("GET", f"/v1/runs/{urllib.parse.quote(run_id)}")["run"]

    def cancel(self, run_id: str) -> Dict[str, Any]:
        return self._client.request("POST", f"/v1/runs/{urllib.parse.quote(run_id)}/cancel")["run"]

    def approve(self, run_id: str, tool_call_id: str, approved: bool, reason: Optional[str] = None) -> None:
        """Approves or rejects a tool call the run is waiting on."""
        body: Dict[str, Any] = {"toolCallId": tool_call_id, "approved": approved}
        if reason:
            body["reason"] = reason
        self._client.request("POST", f"/v1/runs/{urllib.parse.quote(run_id)}/approvals", body=body, retry=False)

    def events(self, run_id: str, *, after: int = 0, max_reconnects: int = 5) -> Iterator[Dict[str, Any]]:
        """The run's events in order until it ends; a dropped connection resumes from the last event."""
        last = after
        failures = 0
        path = f"/v1/runs/{urllib.parse.quote(run_id)}/events"
        while True:
            try:
                for msg in self._client._stream(path, last):
                    event = json.loads(msg["data"])
                    if event["seq"] <= last:
                        continue
                    last = event["seq"]
                    failures = 0
                    yield event
                    if event["type"] in TERMINAL_EVENTS:
                        return
            except NeuroFlowError as err:
                if err.status is not None and not err.retryable:
                    raise
            except (OSError, ValueError):
                pass
            failures += 1
            if failures > max_reconnects:
                raise NeuroFlowError("Event stream kept disconnecting", code="network")
            time.sleep(min(8.0, 0.25 * 2**failures))

    def wait(
        self,
        run_id: str,
        *,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_approval: Optional[ApprovalHandler] = None,
    ) -> Dict[str, Any]:
        """Follows a run until it ends and returns the final run (output, usage, error)."""
        for event in self.events(run_id):
            if on_event:
                on_event(event)
            if event["type"] == "approval.requested" and on_approval:
                self._answer(run_id, event["data"], on_approval)
        return self.get(run_id)

    def run(self, request: Mapping[str, Any], *, idempotency_key: Optional[str] = None, **kwargs: Any) -> Dict[str, Any]:
        """Starts a run and waits for it (``create`` + ``wait``)."""
        created = self.create(request, idempotency_key=idempotency_key)
        return self.wait(created["run"]["id"], **kwargs)

    def stream(self, request: Mapping[str, Any], *, on_approval: Optional[ApprovalHandler] = None) -> Iterator[str]:
        """Yields the answer text as it streams. If the answer restarts (``response.reset``), fetch
        the final run with :meth:`get` for the authoritative ``output``."""
        run_id = self.create(request)["run"]["id"]
        for event in self.events(run_id):
            if event["type"] == "response.delta":
                yield event["data"]["text"]
            elif event["type"] == "approval.requested" and on_approval:
                self._answer(run_id, event["data"], on_approval)

    def _answer(self, run_id: str, data: Dict[str, Any], handler: ApprovalHandler) -> None:
        decision = handler({**data, "runId": run_id})
        if decision is not None:
            self.approve(run_id, data["toolCallId"], bool(decision.get("approved")), decision.get("reason"))
