"""Shared bearer-token check for endpoints that require a verified session."""
import os

from common.security import verify_token

_param_cache = {}


def _get_token_secret(ssm_client):
    if "secret" not in _param_cache:
        param = ssm_client.get_parameter(Name=os.environ["TOKEN_SECRET_PARAM"], WithDecryption=True)
        _param_cache["secret"] = param["Parameter"]["Value"]
    return _param_cache["secret"]


def require_session(event, ssm_client):
    """Returns the token payload dict, or None if missing/invalid/expired."""
    headers = event.get("headers") or {}
    auth_header = headers.get("authorization") or headers.get("Authorization") or ""
    if not auth_header.startswith("Bearer "):
        return None

    token = auth_header[len("Bearer "):].strip()
    secret = _get_token_secret(ssm_client)
    return verify_token(secret, token)
