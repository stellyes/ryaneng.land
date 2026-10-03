"""POST /convert
Headers: Authorization: Bearer <session token>
Body: {"key": str, "targetFormat": str}

Creates a job record and asynchronously invokes the convert_worker container
Lambda (which can run far longer than an API Gateway request timeout allows).
The client polls GET /jobs/{id} for the result.
"""
import json
import os
import time
import uuid

import boto3

from common import ratelimit, responses
from common.auth import require_session
from common.formats import is_valid_source, is_valid_target

_ssm = boto3.client("ssm")
_dynamodb = boto3.resource("dynamodb")
_lambda = boto3.client("lambda")


def handler(event, context):
    payload = require_session(event, _ssm)
    if not payload:
        return responses.unauthorized("Session expired or invalid. Please verify again.")

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return responses.bad_request("Malformed JSON body")

    key = (body.get("key") or "").strip()
    target_format = (body.get("targetFormat") or "").strip().lower()

    # The uploaded key is namespaced with the caller's own code hash; refuse
    # to convert anything outside that namespace.
    if not key.startswith(f"{payload['ch']}/"):
        return responses.unauthorized("That file does not belong to this session.")

    source_extension = key.rsplit(".", 1)[-1] if "." in key else ""
    if not is_valid_source(source_extension):
        return responses.bad_request(f"'.{source_extension}' is not a supported source format.")
    if not is_valid_target(target_format):
        return responses.bad_request(f"'.{target_format}' is not a supported target format.")

    if not ratelimit.check_and_increment(
        os.environ["RATE_LIMIT_TABLE"], "convert-code", payload["ch"], limit=30
    ):
        return responses.too_many_requests()

    job_id = str(uuid.uuid4())
    jobs_table = _dynamodb.Table(os.environ["JOBS_TABLE"])
    jobs_table.put_item(
        Item={
            "jobId": job_id,
            "status": "PENDING",
            "createdAt": int(time.time()),
            "expiresAt": int(time.time()) + 86400,
        }
    )

    _lambda.invoke(
        FunctionName=os.environ["CONVERT_WORKER_FUNCTION"],
        InvocationType="Event",
        Payload=json.dumps(
            {
                "jobId": job_id,
                "sourceKey": key,
                "targetFormat": target_format,
            }
        ).encode("utf-8"),
    )

    return responses.ok({"jobId": job_id})
