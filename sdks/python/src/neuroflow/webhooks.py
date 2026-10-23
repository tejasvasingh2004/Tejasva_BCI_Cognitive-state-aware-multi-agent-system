"""Verification of NeuroFlow webhooks (Standard Webhooks signatures)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Mapping, Optional, Union

from ._errors import WebhookVerificationError


def sign_webhook(secret: str, msg_id: str, timestamp: int, body: Union[str, bytes]) -> str:
    """``v1,<base64 HMAC-SHA256("<id>.<timestamp>.<body>")>`` keyed with the ``whsec_`` secret."""
    key = base64.b64decode(secret[len("whsec_"):] if secret.startswith("whsec_") else secret)
    raw = body.encode() if isinstance(body, str) else body
    digest = hmac.new(key, f"{msg_id}.{timestamp}.".encode() + raw, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def _header(headers: Mapping[str, Any], name: str) -> Optional[str]:
    for key, value in headers.items():
        if key.lower() == name:
            return value[0] if isinstance(value, (list, tuple)) else str(value)
    return None


def verify_webhook(
    secret: str,
    headers: Mapping[str, Any],
    body: Union[str, bytes],
    *,
    tolerance_seconds: int = 300,
    now: Optional[float] = None,
) -> dict:
    """Verifies a delivery and returns the parsed event.

    Pass the **raw** request body exactly as received. Raises :class:`WebhookVerificationError`
    when headers are missing, the timestamp is outside the tolerance window, or no signature matches.
    """
    msg_id = _header(headers, "webhook-id")
    ts = _header(headers, "webhook-timestamp")
    signatures = _header(headers, "webhook-signature")
    if not msg_id or not ts or not signatures:
        raise WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header")
    try:
        timestamp = int(ts)
    except ValueError as exc:
        raise WebhookVerificationError("Invalid webhook timestamp") from exc
    if abs((time.time() if now is None else now) - timestamp) > tolerance_seconds:
        raise WebhookVerificationError("Webhook timestamp is outside the tolerance window")
    expected = sign_webhook(secret, msg_id, timestamp, body)
    if not any(hmac.compare_digest(sig, expected) for sig in signatures.split(" ")):
        raise WebhookVerificationError("Webhook signature does not match")
    return json.loads(body)
