"""POST /uploads
Headers: Authorization: Bearer <session token>
Body: {"filename": str}

Issues a presigned S3 PUT URL for the caller to upload their source file
directly to S3 (keeps the file off the API Lambda entirely). The object key
is namespaced by the caller's code hash + a random id so sessions can't
collide or read each other's files.
"""
import json
import os
import uuid

import boto3

from common import ratelimit, responses
from common.auth import require_session
from common.formats import MAX_UPLOAD_BYTES, is_valid_source

_ssm = boto3.client("ssm")
_s3 = boto3.client("s3")


def handler(event, context):
    payload = require_session(event, _ssm)
    if not payload:
        return responses.unauthorized("Session expired or invalid. Please verify again.")

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return responses.bad_request("Malformed JSON body")

    filename = (body.get("filename") or "").strip()
    if "." not in filename:
        return responses.bad_request("Filename must include an extension.")

    extension = filename.rsplit(".", 1)[1].lower()
    if not is_valid_source(extension):
        return responses.bad_request(f"'.{extension}' is not a supported source format.")

    if not ratelimit.check_and_increment(
        os.environ["RATE_LIMIT_TABLE"], "upload-code", payload["ch"], limit=30
    ):
        return responses.too_many_requests()

    key = f"{payload['ch']}/{uuid.uuid4()}.{extension}"

    # NOTE: presigned PUT can't hard-enforce a max size on its own. A bucket
    # lifecycle rule expires stray objects, and the convert worker re-checks
    # size before doing any real work as defense in depth.
    upload_url = _s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": os.environ["UPLOADS_BUCKET"], "Key": key},
        ExpiresIn=300,
    )

    return responses.ok({"uploadUrl": upload_url, "key": key, "maxBytes": MAX_UPLOAD_BYTES})
