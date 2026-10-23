from __future__ import annotations

from typing import Any, Optional


class NeuroFlowError(Exception):
    """An error answered by the NeuroFlow API (``{"error": {"code", "message"}}``) or a transport failure."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: Optional[int] = None,
        details: Any = None,
        retry_after: Optional[float] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        #: API error code, e.g. ``quota_exceeded`` or ``not_found``; ``network`` / ``timeout`` otherwise.
        self.code = code
        #: HTTP status; ``None`` for network errors and timeouts.
        self.status = status
        self.details = details
        #: Seconds the server asked to wait before retrying (``Retry-After``).
        self.retry_after = retry_after
        #: ``x-request-id`` of the failed request, for support.
        self.request_id = request_id

    @property
    def retryable(self) -> bool:
        return self.status is None or self.status in (408, 429) or self.status >= 500

    def __repr__(self) -> str:
        return f"NeuroFlowError(code={self.code!r}, status={self.status!r}, message={self.message!r})"


class WebhookVerificationError(Exception):
    """A webhook whose signature or timestamp did not verify."""
