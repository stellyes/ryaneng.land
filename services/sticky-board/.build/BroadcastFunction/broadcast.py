"""Only durable transaction event rows trigger public invalidations."""
import concurrent.futures
import json
import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)
TABLE = boto3.resource("dynamodb").Table(os.environ.get("CONNECTIONS_TABLE", "connections"))
GATEWAY = boto3.client("apigatewaymanagementapi",
    endpoint_url=os.environ.get("WS_MANAGEMENT_URL", "https://localhost"))


def send(connection, message):
    connection_id = connection["connectionId"]
    if int(connection["expiresAt"]) <= time.time():
        TABLE.delete_item(Key={"connectionId": connection_id})
        return
    try:
        GATEWAY.post_to_connection(ConnectionId=connection_id, Data=message)
    except ClientError as error:
        if error.response["Error"]["Code"] == "GoneException":
            TABLE.delete_item(Key={"connectionId": connection_id})
        else:
            LOG.error("broadcast_send_failed connection=%s code=%s", connection_id,
                      error.response["Error"]["Code"])
            raise


def broadcast(month, revision):
    payload = json.dumps({"month": month, "revision": revision}, separators=(",", ":")).encode()
    start = None
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        while True:
            args = {"IndexName": "MonthIndex",
                "KeyConditionExpression": "#month = :month",
                "ExpressionAttributeNames": {"#month": "month"},
                "ExpressionAttributeValues": {":month": month}, "Limit": 100}
            if start:
                args["ExclusiveStartKey"] = start
            page = TABLE.query(**args)
            # Wait per bounded page, propagate every non-Gone failure for stream retry.
            jobs = [pool.submit(send, connection, payload) for connection in page.get("Items", [])]
            for job in jobs:
                job.result()
            start = page.get("LastEvaluatedKey")
            if not start:
                return


def handler(event, context):
    failures = []
    for record in event.get("Records", []):
        image = record.get("dynamodb", {}).get("NewImage", {})
        if record.get("eventName") != "INSERT" or not image.get("SK", {}).get("S", "").startswith("EVENT#"):
            continue
        try:
            broadcast(image["month"]["S"], int(image["revision"]["N"]))
        except Exception as error:
            sequence = record["dynamodb"]["SequenceNumber"]
            code = error.response.get("Error", {}).get("Code", "unknown") if isinstance(
                error, ClientError) else type(error).__name__
            LOG.error("durable_event_retry sequence=%s code=%s", sequence, code)
            failures.append({"itemIdentifier": sequence})
    return {"batchItemFailures": failures}
