"""Server-side verification of a Google reCAPTCHA v2 (checkbox) response."""
import json
import urllib.parse
import urllib.request


def verify_recaptcha(secret: str, response_token: str, remote_ip: str = None) -> bool:
    if not response_token:
        return False

    data = {"secret": secret, "response": response_token}
    if remote_ip:
        data["remoteip"] = remote_ip

    body = urllib.parse.urlencode(data).encode("utf-8")
    request = urllib.request.Request(
        "https://www.google.com/recaptcha/api/siteverify",
        data=body,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.loads(response.read().decode("utf-8"))
    except Exception:
        return False

    return bool(result.get("success"))
