"""GET /jobs/{id}
Headers: Authorization: Bearer <session token>

Returns job status, and a short-lived presigned download URL once done.
"""
import os

import boto3
from botocore.config import Config

from common import responses
from common.auth import require_session

_ssm = boto3.client("ssm")
_dynamodb = boto3.resource("dynamodb")
_s3 = boto3.client("s3", config=Config(signature_version="s3v4"))


def handler(event, context):
    payload = require_session(event, _ssm)
    if not payload:
        return responses.unauthorized("Session expired or invalid. Please verify again.")

    job_id = (event.get("pathParameters") or {}).get("id")
    if not job_id:
        return responses.bad_request("Missing job id.")

    jobs_table = _dynamodb.Table(os.environ["JOBS_TABLE"])
    item = jobs_table.get_item(Key={"jobId": job_id}).get("Item")
    if not item:
        return responses.bad_request("Unknown job id.")
    if item.get("codeHash") != payload["ch"]:
        return responses.unauthorized("That job does not belong to this session.")

    result = {"status": item["status"]}

    if item["status"] == "DONE":
        result["downloadUrl"] = _s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": os.environ["OUTPUTS_BUCKET"], "Key": item["resultKey"]},
            ExpiresIn=900,
        )
    elif item["status"] == "ERROR":
        result["error"] = item.get("error", "Conversion failed.")

    return responses.ok(result)
