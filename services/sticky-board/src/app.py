"""Sticky board: opaque device authentication, transactional writes and invalidations."""
import io
import json
import logging
import os
import secrets
import time
import uuid
from decimal import Decimal

import boto3
from boto3.dynamodb.types import TypeSerializer
from botocore.config import Config
from botocore.exceptions import ClientError

from rules import (APIError, MAX_Z, clock, covered, current_month, digest, month_value,
                   pacific_now, placement, public_note, request_hash, request_id,
                   validate_note, version_value)

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)
DB = boto3.resource("dynamodb")
TABLE = DB.Table(os.environ.get("BOARD_TABLE", "board"))
CONNECTIONS = DB.Table(os.environ.get("CONNECTIONS_TABLE", "connections"))
CLIENT = boto3.client("dynamodb")
def image_client(region):
    return boto3.client("s3", region_name=region,
                        endpoint_url=f"https://s3.{region}.amazonaws.com",
                        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


S3 = image_client(boto3.session.Session().region_name)
SERIALIZER = TypeSerializer()
BUCKET = os.environ.get("IMAGES_BUCKET", "")
CDN = os.environ.get("CDN_HOST", "")
ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://example.com")
LOCAL_ORIGIN = os.environ.get("LOCAL_ORIGIN", "http://127.0.0.1:8765")
ALLOWED_ORIGINS = {ORIGIN, LOCAL_ORIGIN, "http://localhost:5500", "http://127.0.0.1:5500"}
RESPONSE_ORIGIN = ORIGIN
WS_URL = os.environ.get("WS_URL", "")
MAX_NOTES = int(os.environ.get("MAX_NOTES", "500"))


def encoded(item):
    def convert(value):
        if isinstance(value, float):
            return Decimal(str(value))
        if isinstance(value, dict):
            return {key: convert(child) for key, child in value.items()}
        if isinstance(value, list):
            return [convert(child) for child in value]
        return value
    return {key: SERIALIZER.serialize(convert(value)) for key, value in item.items()}


def wire(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral() else float(value)
    raise TypeError(f"Unsupported JSON type: {type(value)}")


def response(status, body):
    return {"statusCode": status, "headers": {
        "Content-Type": "application/json", "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": RESPONSE_ORIGIN, "Vary": "Origin"},
        "body": json.dumps(body, default=wire, separators=(",", ":"))}


def get(pk, sk="META"):
    return TABLE.get_item(Key={"PK": pk, "SK": sk}, ConsistentRead=True).get("Item")


def put_action(item, condition=None):
    result = {"TableName": TABLE.name, "Item": encoded(item)}
    if condition:
        result["ConditionExpression"] = condition
    return {"Put": result}


def check_action(pk, sk, expression, values):
    return {"ConditionCheck": {"TableName": TABLE.name,
        "Key": encoded({"PK": pk, "SK": sk}), "ConditionExpression": expression,
        "ExpressionAttributeValues": encoded(values)}}


def delete_action(pk, sk, condition=None, values=None):
    result = {"TableName": TABLE.name, "Key": encoded({"PK": pk, "SK": sk})}
    if condition:
        result["ConditionExpression"] = condition
        result["ExpressionAttributeValues"] = encoded(values)
    return {"Delete": result}


def ttl(seconds):
    return int(time.time()) + seconds


def ip_hash(event):
    context = event.get("requestContext", {})
    ip = context.get("http", {}).get("sourceIp") or context.get("identity", {}).get("sourceIp")
    if not ip:
        raise APIError(400, "missing_source", "Source address is required.")
    return digest(ip)


def limit(key, maximum, window=3600):
    bucket = int(time.time()) // window
    try:
        TABLE.update_item(Key={"PK": f"RATE#{key}#{bucket}", "SK": "META"},
            UpdateExpression="SET expiresAt = :expiry ADD hits :one",
            ConditionExpression="attribute_not_exists(hits) OR hits < :maximum",
            ExpressionAttributeValues={":expiry": ttl(window * 2), ":one": 1,
                                       ":maximum": maximum})
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise APIError(429, "rate_limited", "Rate limit reached; try again later.") from error
        raise


def authenticate(event):
    headers = {key.lower(): value for key, value in event.get("headers", {}).items()}
    auth = headers.get("authorization", "")
    if not auth.startswith("Bearer ") or len(auth) > 200:
        raise APIError(401, "unauthorized", "A device credential is required.")
    credential = auth[7:]
    record = get(f"DEVICE#{digest(credential)}")
    if not record:
        raise APIError(401, "unauthorized", "Unknown device credential.")
    return record["deviceId"]


def identity_limit(event, device, category, daily=60):
    limit(f"{category}:device:{device}", daily, 86400)
    limit(f"{category}:ip:{ip_hash(event)}", daily * 10, 86400)


def read_meta(month):
    return get(f"BOARD#{month}") or {
        "PK": f"BOARD#{month}", "SK": "META", "revision": 0, "maxZ": 0, "noteCount": 0}


def snapshot(month):
    for _ in range(4):
        before = read_meta(month)
        notes, start = [], None
        while True:
            args = {"KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
                "ExpressionAttributeValues": {":pk": f"BOARD#{month}", ":prefix": "NOTE#"},
                "ConsistentRead": True}
            if start:
                args["ExclusiveStartKey"] = start
            page = TABLE.query(**args)
            notes.extend(page.get("Items", []))
            start = page.get("LastEvaluatedKey")
            if not start:
                break
        after = read_meta(month)
        if before["revision"] == after["revision"]:
            return after, notes
    raise APIError(503, "board_busy", "Snapshot changed repeatedly; retry shortly.")


def existing_retry(month, device, rid, fingerprint):
    previous = get(f"BOARD#{month}", f"REQUEST#{device}#{rid}")
    if previous:
        if previous["fingerprint"] != fingerprint:
            raise APIError(409, "request_id_reused", "requestId was used for a different request.")
        return previous["result"]
    return None


def transactional_change(month, device, rid, fingerprint, prepare, posting=True):
    """CAS the revision with every note, claim, durable event and retry record."""
    previous = existing_retry(month, device, rid, fingerprint)
    if previous:
        return previous
    pk = f"BOARD#{month}"
    for attempt in range(5):
        if posting and (get("SETTINGS") or {}).get("postingEnabled") is False:
            raise APIError(503, "posting_disabled", "Posting is temporarily disabled.")
        meta, notes = snapshot(month)
        if posting and month != current_month():
            raise APIError(409, "month_changed", "Only the current Pacific month is writable.")
        revision = int(meta["revision"]) + 1
        actions, changes, result = prepare(meta, notes, revision)
        next_meta = dict(meta, revision=revision, **changes)
        if meta["revision"] == 0:
            meta_action = put_action(next_meta, "attribute_not_exists(PK)")
        else:
            meta_action = put_action(next_meta, "revision = :old")
            meta_action["Put"]["ExpressionAttributeValues"] = encoded({":old": meta["revision"]})
        result = dict(result, month=month, revision=revision)
        actions.extend([meta_action,
            put_action({"PK": pk, "SK": f"EVENT#{revision:012d}", "month": month,
                        "revision": revision, "expiresAt": ttl(172800)}, "attribute_not_exists(PK)"),
            put_action({"PK": pk, "SK": f"REQUEST#{device}#{rid}",
                        "fingerprint": fingerprint, "result": result,
                        "expiresAt": ttl(45 * 86400)}, "attribute_not_exists(PK)")])
        if posting:
            actions.append(check_action("SETTINGS", "META",
                "attribute_not_exists(postingEnabled) OR postingEnabled = :enabled",
                {":enabled": True}))
        try:
            CLIENT.transact_write_items(TransactItems=actions,
                                       ClientRequestToken=str(uuid.uuid4()))
            return result
        except ClientError as error:
            code = error.response["Error"]["Code"]
            if code not in {"TransactionCanceledException", "TransactionConflictException"}:
                raise
            reasons = error.response.get("CancellationReasons", [])
            if any(reason.get("Code") not in (
                    None, "None", "ConditionalCheckFailed", "TransactionConflict") for reason in reasons):
                raise
            previous = existing_retry(month, device, rid, fingerprint)
            if previous:
                return previous
            LOG.warning("transaction_contention attempt=%s month=%s", attempt + 1, month)
            time.sleep(0.02 * (attempt + 1))
    raise APIError(409, "write_conflict", "Board changed; fetch a fresh snapshot and retry.")


def find_note(notes, note_id, device=None, version=None):
    note = next((item for item in notes if item["id"] == note_id), None)
    if not note:
        raise APIError(404, "not_found", "Note not found.")
    if device is not None and note["owner"] != device:
        raise APIError(403, "not_owner", "Only your own note can be changed.")
    if version is not None and note["version"] != version:
        raise APIError(409, "version_conflict", "Note changed; fetch the board again.")
    return note


def next_z(meta):
    if int(meta["maxZ"]) >= MAX_Z:
        raise APIError(409, "layer_limit", "Board layer limit reached.")
    return int(meta["maxZ"]) + 1


def mutation(event, method, path, body, device):
    month = month_value(body.get("month"), writable=True)
    rid = request_id(body)
    fingerprint = request_hash(method, path, body)
    previous = existing_retry(month, device, rid, fingerprint)
    if previous:
        return previous
    identity_limit(event, device, "mutation", 120)
    pk = f"BOARD#{month}"
    if method == "POST" and path == "/notes":
        fields = validate_note(body)
        asset = None
        if fields["type"] != "text":
            asset = get(f"ASSET#{fields['assetId']}")
            if not asset or asset.get("owner") != device or asset.get("state") != "ready":
                raise APIError(400, "invalid_asset", "Asset must be finalized and owned by this device.")
            if int(asset.get("expiresAt", 0)) <= time.time():
                raise APIError(400, "invalid_asset", "Asset expired.")
            fields["content"] = f"https://{CDN}/published/{fields.pop('assetId')}.webp"
        note_id = uuid.uuid4().hex

        def prepare(meta, notes, revision):
            if get(pk, f"CLAIM#{device}"):
                raise APIError(409, "monthly_limit", "One note per device per Pacific month.")
            if int(meta["noteCount"]) >= MAX_NOTES:
                raise APIError(409, "board_full", "The board is full for this month.")
            z = next_z(meta)
            note = dict(fields, PK=pk, SK=f"NOTE#{note_id}", id=note_id, owner=device,
                        z=z, version=1, createdAt=pacific_now().isoformat(),
                        bumpedOn=pacific_now().strftime("%Y-%m-%d"))
            actions = [put_action(note, "attribute_not_exists(PK)"),
                put_action({"PK": pk, "SK": f"CLAIM#{device}", "noteId": note_id},
                           "attribute_not_exists(PK)")]
            if asset:
                actions.append(check_action(asset["PK"], "META",
                    "#state = :ready AND #owner = :owner AND expiresAt > :now",
                    {":ready": "ready", ":owner": device, ":now": int(time.time())}))
                actions[-1]["ConditionCheck"]["ExpressionAttributeNames"] = {
                    "#state": "state", "#owner": "owner"}
            return actions, {"maxZ": z, "noteCount": int(meta["noteCount"]) + 1}, {
                "note": public_note(note, device)}
        return transactional_change(month, device, rid, fingerprint, prepare)
    parts = path.strip("/").split("/")
    if len(parts) not in (2, 3) or parts[0] != "notes":
        raise APIError(404, "not_found", "Unknown route.")
    note_id = parts[1]
    version = version_value(body)
    bump = method == "POST" and len(parts) == 3 and parts[2] == "bump"
    if not bump and not (method == "PATCH" and len(parts) == 2):
        raise APIError(404, "not_found", "Unknown route.")
    if bump:
        identity_limit(event, device, "bump", 10)
        position = {}
    else:
        position = placement(body)

    def prepare(meta, notes, revision):
        old = find_note(notes, note_id, device, version)
        changes = {}
        if bump:
            if old.get("bumpedOn") == pacific_now().strftime("%Y-%m-%d"):
                raise APIError(409, "bump_daily_limit", "A note can be bumped once per Pacific day.")
            if not covered(old, notes):
                raise APIError(409, "not_covered", "Only an overlapped note can be bumped.")
            changes["maxZ"] = next_z(meta)
            position.update(z=changes["maxZ"], bumpedOn=pacific_now().strftime("%Y-%m-%d"))
        note = dict(old, **position, version=int(old["version"]) + 1)
        action = put_action(note, "version = :version AND #owner = :owner")
        action["Put"]["ExpressionAttributeNames"] = {"#owner": "owner"}
        action["Put"]["ExpressionAttributeValues"] = encoded({":version": version, ":owner": device})
        return [action], changes, {"note": public_note(note, device)}
    return transactional_change(month, device, rid, fingerprint, prepare)


def upload(event, device):
    if (get("SETTINGS") or {}).get("postingEnabled") is False:
        raise APIError(503, "posting_disabled", "Posting is temporarily disabled.")
    identity_limit(event, device, "upload", 10)
    asset_id = uuid.uuid4().hex
    TABLE.put_item(Item={"PK": f"ASSET#{asset_id}", "SK": "META", "owner": device,
        "state": "staged", "expiresAt": ttl(86400)})
    signed = S3.generate_presigned_post(Bucket=BUCKET, Key=f"staged/{asset_id}",
        Conditions=[["content-length-range", 1, 1048576]], ExpiresIn=300)
    return {"assetId": asset_id, "url": signed["url"], "fields": signed["fields"],
            "expiresIn": 300, "maxBytes": 1048576}


def finalize(event, device, asset_id):
    import warnings
    from PIL import Image, ImageOps, UnidentifiedImageError
    if not asset_id or len(asset_id) != 32 or any(c not in "0123456789abcdef" for c in asset_id):
        raise APIError(400, "invalid_asset", "Invalid assetId.")
    identity_limit(event, device, "finalize", 20)
    if (get("SETTINGS") or {}).get("postingEnabled") is False:
        raise APIError(503, "posting_disabled", "Posting is temporarily disabled.")
    asset = get(f"ASSET#{asset_id}")
    if not asset or asset.get("owner") != device or asset["expiresAt"] <= time.time():
        raise APIError(404, "invalid_asset", "Asset not found or expired.")
    if asset["state"] == "ready":
        return {"assetId": asset_id}
    try:
        obj = S3.get_object(Bucket=BUCKET, Key=f"staged/{asset_id}")
    except ClientError as error:
        if error.response["Error"]["Code"] in {"NoSuchKey", "404"}:
            raise APIError(409, "upload_missing", "Upload the file before finalizing.") from error
        raise
    stream = obj["Body"]
    try:
        data = stream.read(1048577)
    finally:
        stream.close()
    if not data or len(data) > 1048576:
        raise APIError(400, "image_too_large", "Image must not exceed 1 MiB.")
    Image.MAX_IMAGE_PIXELS = 16_000_000
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.width * image.height > 16_000_000 or image.format not in {
                        "JPEG", "PNG", "WEBP"}:
                    raise APIError(400, "invalid_image", "Use a JPEG, PNG or WebP up to 16 megapixels.")
                image.load()
                image = ImageOps.exif_transpose(image).convert("RGB")
                clean = Image.new("RGB", (480, 480), "white")
                clean.paste(ImageOps.fit(image, (480, 480), method=Image.Resampling.LANCZOS))
                output = io.BytesIO()
                clean.save(output, "WEBP", quality=82, method=4)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError,
            Image.DecompressionBombWarning, ValueError) as error:
        raise APIError(400, "invalid_image", "Image could not be safely decoded.") from error
    S3.put_object(Bucket=BUCKET, Key=f"published/{asset_id}.webp", Body=output.getvalue(),
                  ContentType="image/webp", CacheControl="public,max-age=86400")
    TABLE.update_item(Key={"PK": asset["PK"], "SK": "META"},
        UpdateExpression="SET #state = :ready, expiresAt = :expiry",
        ConditionExpression="#owner = :owner AND expiresAt > :now",
        ExpressionAttributeNames={"#state": "state", "#owner": "owner"},
        ExpressionAttributeValues={":ready": "ready", ":expiry": ttl(40 * 86400),
                                   ":owner": device, ":now": int(time.time())})
    S3.delete_object(Bucket=BUCKET, Key=f"staged/{asset_id}")
    return {"assetId": asset_id}


def ticket(event, device):
    identity_limit(event, device, "ticket", 150)
    limit(f"ticket-hour:{device}", 12, 3600)
    value = secrets.token_urlsafe(32)
    expiry = ttl(60)
    TABLE.put_item(Item={"PK": f"TICKET#{digest(value)}", "SK": "META",
        "deviceId": device, "expiresAt": expiry})
    return {"ticket": value, "url": WS_URL, "expiresAt": expiry}


def acquire_session(device, connection_id):
    for slot in range(4):
        key = {"PK": f"SESSIONS#{device}", "SK": f"SLOT#{slot}"}
        try:
            TABLE.put_item(Item=dict(key, connectionId=connection_id, expiresAt=ttl(7200)),
                ConditionExpression="attribute_not_exists(expiresAt) OR expiresAt <= :now",
                ExpressionAttributeValues={":now": int(time.time())})
            return key
        except ClientError as error:
            if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    raise APIError(429, "session_limit", "At most four active sessions per device; close another tab.")


def release_session(key, connection_id):
    try:
        TABLE.delete_item(Key=key, ConditionExpression="connectionId = :id",
                          ExpressionAttributeValues={":id": connection_id})
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def websocket(event):
    context = event["requestContext"]
    route = context["routeKey"]
    connection_id = context["connectionId"]
    if route == "$connect":
        headers = {key.lower(): value for key, value in event.get("headers", {}).items()}
        if headers.get("origin") not in ALLOWED_ORIGINS:
            raise APIError(403, "invalid_origin", "Origin is not allowed.")
        value = (event.get("queryStringParameters") or {}).get("ticket", "")
        if not value or len(value) > 100:
            raise APIError(401, "invalid_ticket", "A connection ticket is required.")
        try:
            record = TABLE.delete_item(Key={"PK": f"TICKET#{digest(value)}", "SK": "META"},
                ConditionExpression="expiresAt > :now",
                ExpressionAttributeValues={":now": int(time.time())},
                ReturnValues="ALL_OLD")["Attributes"]
        except ClientError as error:
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise APIError(401, "invalid_ticket", "Ticket expired or already used.") from error
            raise
        limit(f"connections:{record['deviceId']}", 12, 3600)
        lease = acquire_session(record["deviceId"], connection_id)
        try:
            CONNECTIONS.put_item(Item={"connectionId": connection_id,
                "deviceId": record["deviceId"], "month": current_month(),
                "expiresAt": ttl(7200), "lease": lease})
        except Exception:
            release_session(lease, connection_id)
            raise
        return response(200, {"connected": True})
    if route == "$disconnect":
        old = CONNECTIONS.get_item(Key={"connectionId": connection_id},
                                   ConsistentRead=True).get("Item")
        CONNECTIONS.delete_item(Key={"connectionId": connection_id})
        if old and old.get("lease"):
            release_session(old["lease"], connection_id)
        return response(200, {"disconnected": True})
    connection = CONNECTIONS.get_item(Key={"connectionId": connection_id},
                                     ConsistentRead=True).get("Item")
    if not connection or connection["expiresAt"] <= time.time():
        raise APIError(401, "connection_expired", "Reconnect with a fresh ticket.")
    if route == "heartbeat":
        limit(f"heartbeat:{connection_id}", 150, 3600)
        month = current_month()
        CONNECTIONS.update_item(Key={"connectionId": connection_id},
            UpdateExpression="SET #month = :month",
            ExpressionAttributeNames={"#month": "month"},
            ExpressionAttributeValues={":month": month})
        gateway = boto3.client("apigatewaymanagementapi",
            endpoint_url=f"https://{context['domainName']}/{context['stage']}")
        try:
            gateway.post_to_connection(ConnectionId=connection_id,
                Data=json.dumps({"month": month, "revision": int(read_meta(month)["revision"])}).encode())
        except ClientError as error:
            if error.response["Error"]["Code"] == "GoneException":
                CONNECTIONS.delete_item(Key={"connectionId": connection_id})
            else:
                raise
        return response(200, {"heartbeat": True})
    raise APIError(400, "invalid_action", "Only heartbeat is supported.")


def admin(event, method, path, body):
    if not event.get("requestContext", {}).get("authorizer", {}).get("iam"):
        raise APIError(403, "iam_required", "This route requires AWS IAM authentication.")
    if method == "PUT" and path == "/admin/settings":
        enabled = body.get("postingEnabled")
        if not isinstance(enabled, bool):
            raise APIError(400, "invalid_input", "postingEnabled must be a boolean.")
        TABLE.put_item(Item={"PK": "SETTINGS", "SK": "META", "postingEnabled": enabled})
        return {"postingEnabled": enabled}
    if method == "DELETE" and path.startswith("/admin/notes/"):
        month = month_value((event.get("queryStringParameters") or {}).get("month"))
        note_id = path.split("/")[-1]
        rid = request_id(body)
        fingerprint = request_hash(method, path, dict(body, month=month))

        def prepare(meta, notes, revision):
            note = find_note(notes, note_id)
            # Keep the monthly claim: moderation must not grant another posting slot.
            return [delete_action(note["PK"], note["SK"], "version = :old",
                                  {":old": note["version"]})], {
                "noteCount": max(0, int(meta["noteCount"]) - 1)}, {"deleted": note_id}
        return transactional_change(month, "admin", rid, fingerprint, prepare, posting=False)
    raise APIError(404, "not_found", "Unknown admin route.")


def handler(event, context):
    global RESPONSE_ORIGIN
    origin = next((value for key, value in event.get("headers", {}).items()
                   if key.lower() == "origin"), ORIGIN)
    RESPONSE_ORIGIN = origin if origin in ALLOWED_ORIGINS else ORIGIN
    trace = event.get("requestContext", {}).get("requestId", "unknown")
    try:
        request_context = event.get("requestContext", {})
        if "connectionId" in request_context:
            return websocket(event)
        method = request_context.get("http", {}).get("method", "")
        path = event.get("rawPath", "")
        raw = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            import base64
            try:
                raw = base64.b64decode(raw, validate=True).decode("utf-8")
            except (ValueError, UnicodeError) as error:
                raise APIError(400, "invalid_json", "Invalid encoded request body.") from error
        if len(raw) > 8192:
            raise APIError(413, "body_too_large", "Request body is too large.")
        try:
            body = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError) as error:
            raise APIError(400, "invalid_json", "Invalid JSON body.") from error
        if not isinstance(body, dict):
            raise APIError(400, "invalid_json", "Request body must be a JSON object.")
        if path.startswith("/admin/"):
            return response(200, admin(event, method, path, body))
        headers = {key.lower(): value for key, value in event.get("headers", {}).items()}
        if headers.get("origin") not in ALLOWED_ORIGINS | {None}:
            raise APIError(403, "invalid_origin", "Origin is not allowed.")
        if method == "POST" and path == "/devices":
            limit(f"device-hour:{ip_hash(event)}", 5, 3600)
            limit(f"device-day:{ip_hash(event)}", 20, 86400)
            credential, device = secrets.token_urlsafe(32), uuid.uuid4().hex
            TABLE.put_item(Item={"PK": f"DEVICE#{digest(credential)}", "SK": "META",
                                 "deviceId": device, "createdAt": int(time.time())})
            return response(201, {"credential": credential, "deviceId": device})
        device = authenticate(event)
        if method == "GET" and path in {"/board", "/revision"}:
            query = event.get("queryStringParameters") or {}
            month = month_value(query.get("month"))
            if path == "/board":
                limit(f"snapshot:{device}", 90, 60)
            meta = read_meta(month)
            result = {"month": month, "revision": int(meta["revision"]), **clock()}
            if path == "/revision":
                return response(200, result)
            result["deviceId"] = device
            result["hasPosted"] = get(f"BOARD#{month}", f"CLAIM#{device}") is not None
            if query.get("revision") == str(meta["revision"]):
                return response(200, dict(result, unchanged=True))
            meta, notes = snapshot(month)
            result["hasPosted"] = get(f"BOARD#{month}", f"CLAIM#{device}") is not None
            result.update(revision=int(meta["revision"]),
                          notes=[public_note(note, device) for note in notes])
            return response(200, result)
        if method == "POST" and path == "/connections/ticket":
            return response(201, ticket(event, device))
        if method == "POST" and path == "/uploads":
            return response(201, upload(event, device))
        if method == "POST" and path.startswith("/uploads/") and path.endswith("/finalize"):
            return response(200, finalize(event, device, path.split("/")[2]))
        if path.startswith("/notes") and method in {"POST", "PATCH"}:
            return response(200, mutation(event, method, path, body, device))
        raise APIError(404, "not_found", "Unknown route.")
    except APIError as error:
        LOG.warning("request_rejected requestId=%s code=%s status=%s", trace, error.code, error.status)
        return response(error.status, {"error": {"code": error.code, "message": str(error)},
                                       "message": str(error), "requestId": trace})
    except Exception:
        # Deliberately omit event/body/credentials and SDK messages from logs.
        import sys
        error = sys.exc_info()[1]
        code = error.response.get("Error", {}).get("Code", "unknown") if isinstance(
            error, ClientError) else type(error).__name__
        LOG.error("cloud_or_internal_failure requestId=%s code=%s", trace, code)
        return response(503, {"error": {"code": "service_unavailable",
                                      "message": "Service unavailable; retry shortly."},
                              "message": "Service unavailable; retry shortly.",
                              "requestId": trace})
