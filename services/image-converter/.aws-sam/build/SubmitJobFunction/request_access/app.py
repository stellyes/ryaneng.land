"""POST /request-access
Body: {"name": str, "email": str, "reason": str (optional), "captchaToken": str, "website": "" (honeypot)}

Forwards the request to the site owner's email via SES. Does not touch the
AccessCodes table at all -- codes are minted and sent manually by the owner
after reviewing the email, which is the "low-tech but robust" design the
owner asked for (no automated code issuance to abuse).
"""
import json
import os
import re

import boto3

from common import ratelimit, responses
from common.recaptcha import verify_recaptcha
from common.devbypass import is_dev_bypass

_ssm = boto3.client("ssm")
_ses = boto3.client("ses")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_param_cache = {}


def _get_recaptcha_secret():
    if "secret" not in _param_cache:
        param = _ssm.get_parameter(Name=os.environ["RECAPTCHA_SECRET_PARAM"], WithDecryption=True)
        _param_cache["secret"] = param["Parameter"]["Value"]
    return _param_cache["secret"]


def handler(event, context):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return responses.bad_request("Malformed JSON body")

    # Honeypot field: real users never fill this in, bots often do.
    if body.get("website"):
        return responses.ok({"message": "Thanks! Your request has been sent."})

    name = (body.get("name") or "").strip()[:200]
    email = (body.get("email") or "").strip()[:320]
    reason = (body.get("reason") or "").strip()[:2000]
    captcha_token = body.get("captchaToken")

    if not name or not EMAIL_RE.match(email):
        return responses.bad_request("A valid name and email are required.")

    if not is_dev_bypass(event, _ssm) and not verify_recaptcha(_get_recaptcha_secret(), captcha_token):
        return responses.bad_request("Captcha verification failed.")

    source_ip = event.get("requestContext", {}).get("http", {}).get("sourceIp", "unknown")

    if not ratelimit.check_and_increment(
        os.environ["RATE_LIMIT_TABLE"], "request-access-ip", source_ip, limit=5
    ):
        return responses.too_many_requests()
    if not ratelimit.check_and_increment(
        os.environ["RATE_LIMIT_TABLE"], "request-access-email", email.lower(), limit=3
    ):
        return responses.too_many_requests()

    _ses.send_email(
        Source=os.environ["SES_FROM_ADDRESS"],
        Destination={"ToAddresses": [os.environ["SES_TO_ADDRESS"]]},
        ReplyToAddresses=[email],
        Message={
            "Subject": {"Data": f"Image converter access request from {name}"},
            "Body": {
                "Text": {
                    "Data": (
                        f"Name: {name}\n"
                        f"Email: {email}\n"
                        f"Source IP: {source_ip}\n\n"
                        f"Message:\n{reason or '(none provided)'}"
                    )
                }
            },
        },
    )

    return responses.ok({"message": "Thanks! Your request has been sent."})
