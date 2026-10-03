"""Dev-only captcha bypass for local testing.

Checked via a server-side shared secret (SSM), never a client-guessable
condition like hostname/origin, since those are trivially spoofable by a
non-browser client. Requesters must send header `X-Dev-Bypass: <secret>`
matching the value in SSM. The secret is never embedded in any file shipped
to the browser -- set it manually via localStorage when testing locally.
"""
import hmac
import os

_param_cache = {}


def _get_secret(ssm_client):
    if "secret" not in _param_cache:
        param = ssm_client.get_parameter(Name=os.environ["DEV_BYPASS_SECRET_PARAM"], WithDecryption=True)
        _param_cache["secret"] = param["Parameter"]["Value"]
    return _param_cache["secret"]


def is_dev_bypass(event, ssm_client) -> bool:
    headers = event.get("headers") or {}
    provided = headers.get("x-dev-bypass") or headers.get("X-Dev-Bypass")
    if not provided:
        return False

    secret = _get_secret(ssm_client)
    # Placeholder value means nobody has set a real secret yet -- never bypass.
    if not secret or secret.startswith("CHANGE_ME"):
        return False

    return hmac.compare_digest(provided, secret)
