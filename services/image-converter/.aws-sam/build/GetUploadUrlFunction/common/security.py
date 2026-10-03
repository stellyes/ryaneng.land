"""Stateless session tokens.

Rather than a server-side session table (extra cost + moving part), a
verified access code mints a short-lived HMAC-signed token. Any Lambda can
verify it locally with no DynamoDB round trip.

Token format: base64url(payload_json) + "." + base64url(hmac_sha256(payload_json))
"""
import base64
import hashlib
import hmac
import json
import time


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def issue_token(secret: str, code_hash: str, ttl_seconds: int = 7200) -> str:
    payload = {"ch": code_hash, "exp": int(time.time()) + ttl_seconds}
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    return f"{_b64url_encode(payload_bytes)}.{_b64url_encode(signature)}"


def verify_token(secret: str, token: str):
    """Returns the payload dict if valid and unexpired, else None."""
    try:
        payload_part, signature_part = token.split(".", 1)
        payload_bytes = _b64url_decode(payload_part)
        signature = _b64url_decode(signature_part)
    except (ValueError, Exception):
        return None

    expected_signature = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected_signature):
        return None

    payload = json.loads(payload_bytes)
    if payload.get("exp", 0) < time.time():
        return None
    return payload


def hash_code(raw_code: str) -> str:
    """Access codes are never stored in plaintext, only their hash."""
    return hashlib.sha256(raw_code.strip().encode("utf-8")).hexdigest()
