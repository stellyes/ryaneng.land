"""POST /verify
Body: {"code": str, "captchaToken": str}

Validates the captcha + access code against DynamoDB, enforces per-code and
per-IP rate limits, then mints a short-lived stateless session token used by
the upload/convert endpoints. The raw code is never stored -- only its
SHA-256 hash -- so a leak of the table doesn't leak usable codes.
"""
import json
import os
import time

import boto3

from common import ratelimit, responses
from common.recaptcha import verify_recaptcha
from common.security import hash_code, issue_token
from common.devbypass import is_dev_bypass

_ssm = boto3.client("ssm")
_dynamodb = boto3.resource("dynamodb")

_param_cache = {}


def _get_param(name_env):
    if name_env not in _param_cache:
        param = _ssm.get_parameter(Name=os.environ[name_env], WithDecryption=True)
        _param_cache[name_env] = param["Parameter"]["Value"]
    return _param_cache[name_env]


def handler(event, context):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return responses.bad_request("Malformed JSON body")

    raw_code = (body.get("code") or "").strip()
    captcha_token = body.get("captchaToken")

    if not raw_code:
        return responses.bad_request("Access code is required.")

    recaptcha_secret = _get_param("RECAPTCHA_SECRET_PARAM")
    if not is_dev_bypass(event, _ssm) and not verify_recaptcha(recaptcha_secret, captcha_token):
        return responses.bad_request("Captcha verification failed.")

    source_ip = event.get("requestContext", {}).get("http", {}).get("sourceIp", "unknown")

    # Cap verify attempts per IP regardless of outcome, to slow down guessing.
    if not ratelimit.check_and_increment(
        os.environ["RATE_LIMIT_TABLE"], "verify-ip", source_ip, limit=20
    ):
        return responses.too_many_requests()

    code_hash = hash_code(raw_code)
    table = _dynamodb.Table(os.environ["ACCESS_CODES_TABLE"])
    item = table.get_item(Key={"codeHash": code_hash}).get("Item")

    if not item or item.get("disabled"):
        return responses.unauthorized("Invalid or disabled access code.")

    if item.get("expiresAt") and int(item["expiresAt"]) < int(time.time()):
        return responses.unauthorized("This access code has expired.")

    max_uses = int(item.get("maxUses", 0))
    if max_uses > 0:
        try:
            table.update_item(
                Key={"codeHash": code_hash},
                UpdateExpression="SET #u = if_not_exists(#u, :zero) + :one",
                ConditionExpression="attribute_not_exists(#u) OR #u < :max",
                ExpressionAttributeNames={"#u": "uses"},
                ExpressionAttributeValues={":zero": 0, ":one": 1, ":max": max_uses},
            )
        except _dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
            return responses.unauthorized("This access code has reached its usage limit.")

    token_secret = _get_param("TOKEN_SECRET_PARAM")
    token = issue_token(token_secret, code_hash)

    return responses.ok({"token": token, "expiresIn": 7200})
