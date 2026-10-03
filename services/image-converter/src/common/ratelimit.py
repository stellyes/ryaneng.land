"""Cheap, atomic, per-day rate limiting backed by a single on-demand DynamoDB table.

Each bucket (e.g. "ip#1.2.3.4#request-access#2026-09-30") gets one item with a
`count` attribute and a TTL so old buckets self-delete (no cleanup job needed).
The increment-and-check is a single conditional UpdateItem call, so it's safe
against concurrent requests.
"""
import time
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

_dynamodb = boto3.resource("dynamodb")


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def check_and_increment(table_name: str, scope: str, identity: str, limit: int) -> bool:
    """Returns True if the action is allowed (and records it), False if over limit."""
    table = _dynamodb.Table(table_name)
    bucket_key = f"{scope}#{identity}#{_today()}"
    ttl = int(time.time()) + (48 * 60 * 60)  # keep for 2 days then auto-expire

    try:
        table.update_item(
            Key={"bucketKey": bucket_key},
            UpdateExpression="SET #c = if_not_exists(#c, :zero) + :one, #ttl = if_not_exists(#ttl, :ttl)",
            ConditionExpression="attribute_not_exists(#c) OR #c < :limit",
            ExpressionAttributeNames={"#c": "count", "#ttl": "expiresAt"},
            ExpressionAttributeValues={":zero": 0, ":one": 1, ":limit": limit, ":ttl": ttl},
        )
        return True
    except ClientError as err:
        if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
