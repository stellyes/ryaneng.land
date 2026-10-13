"""Copy a frozen sticky-board deployment, including anonymous ownership records."""

import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "sticky-board" / ".build" / "ApiFunction"))
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def stack(region, name):
    client = boto3.client("cloudformation", region_name=region)
    description = client.describe_stacks(StackName=name)["Stacks"][0]
    outputs = {item["OutputKey"]: item["OutputValue"] for item in description["Outputs"]}
    resources = client.describe_stack_resource(StackName=name, LogicalResourceId="ApiFunction")
    outputs["ApiFunction"] = resources["StackResourceDetail"]["PhysicalResourceId"]
    return outputs


def scan(client, table):
    items = []
    options = {"TableName": table, "ConsistentRead": True}
    while True:
        response = client.scan(**options)
        items.extend(response["Items"])
        if "LastEvaluatedKey" not in response:
            return items
        options["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def fingerprint(items):
    ordered = sorted(items, key=lambda item: (item["PK"]["S"], item["SK"]["S"]))
    return hashlib.sha256(json.dumps(ordered, sort_keys=True).encode()).hexdigest()


def settings(api, region, enabled):
    body = json.dumps({"postingEnabled": enabled}).encode()
    url = api + "/admin/settings"
    request = AWSRequest(method="PUT", url=url, data=body, headers={"Content-Type": "application/json"})
    credentials = boto3.Session().get_credentials().get_frozen_credentials()
    SigV4Auth(credentials, "execute-api", region).add_auth(request)
    with urlopen(Request(url, data=body, headers=dict(request.headers), method="PUT"), timeout=30) as response:
        result = json.load(response)
        if result.get("postingEnabled") is not enabled:
            raise RuntimeError("Posting switch did not acknowledge requested state")


def rewrite(value, old, new):
    if isinstance(value, str):
        return value.replace(old + "/published/", new + "/published/")
    if isinstance(value, list):
        return [rewrite(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: rewrite(item, old, new) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-region", required=True)
    parser.add_argument("--source-stack", required=True)
    parser.add_argument("--destination-region", required=True)
    parser.add_argument("--destination-stack", required=True)
    parser.add_argument("--backup-directory", required=True)
    args = parser.parse_args()
    if args.source_region == args.destination_region:
        parser.error("Source and destination regions must differ")
    backup = Path(args.backup_directory)
    backup.mkdir(parents=True, exist_ok=True)
    if (backup / "board.json").exists():
        raise RuntimeError("Backup already exists; use a new directory rather than overwrite it")
    source = stack(args.source_region, args.source_stack)
    destination = stack(args.destination_region, args.destination_stack)
    source_db = boto3.client("dynamodb", region_name=args.source_region)
    dest_db = boto3.client("dynamodb", region_name=args.destination_region)
    if scan(dest_db, destination["BoardTableName"]):
        raise RuntimeError("Destination board is not empty; refusing to overwrite it")
    previous = source_db.get_item(TableName=source["BoardTableName"],
                                  Key={"PK": {"S": "SETTINGS"}, "SK": {"S": "META"}},
                                  ConsistentRead=True).get("Item", {})
    previous_enabled = previous.get("postingEnabled", {}).get("BOOL", True)
    (backup / "deployment.json").write_text(json.dumps({
        "source": source, "destination": destination, "previousPostingEnabled": previous_enabled,
    }, indent=2))
    settings(source["ApiUrl"], args.source_region, False)
    source_lambda = boto3.client("lambda", region_name=args.source_region)
    source_lambda.put_function_concurrency(FunctionName=source["ApiFunction"], ReservedConcurrentExecutions=0)
    print("Source frozen; old API disabled to prevent changes during transfer.")
    source_items = scan(source_db, source["BoardTableName"])
    (backup / "board.json").write_text(json.dumps(source_items), encoding="utf-8")
    print(f"Backed up {len(source_items)} board records (credentials are not printed).")

    source_s3 = boto3.client("s3", region_name=args.source_region)
    dest_s3 = boto3.client("s3", region_name=args.destination_region)
    objects = []
    for page in source_s3.get_paginator("list_objects_v2").paginate(Bucket=source["ImagesBucketName"]):
        objects.extend(page.get("Contents", []))
    manifest = []
    for item in objects:
        key = item["Key"]
        if not key.startswith(("published/", "staged/")):
            raise RuntimeError(f"Unexpected image prefix: {key}")
        response = source_s3.get_object(Bucket=source["ImagesBucketName"], Key=key)
        data = response["Body"].read()
        local = backup / "images" / key
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(data)
        dest_s3.put_object(Bucket=destination["ImagesBucketName"], Key=key, Body=data,
                          ContentType=response.get("ContentType", "application/octet-stream"),
                          CacheControl=response.get("CacheControl", "max-age=31536000,immutable"),
                          Metadata=response.get("Metadata", {}))
        copied = dest_s3.get_object(Bucket=destination["ImagesBucketName"], Key=key)["Body"].read()
        if hashlib.sha256(data).digest() != hashlib.sha256(copied).digest():
            raise RuntimeError("Image verification failed")
        manifest.append({"key": key, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    (backup / "images.json").write_text(json.dumps(manifest), encoding="utf-8")
    print(f"Copied and byte-verified {len(manifest)} images.")
    transformed = rewrite(source_items, source["MediaUrl"], destination["MediaUrl"])
    table = boto3.resource("dynamodb", region_name=args.destination_region).Table(destination["BoardTableName"])
    from boto3.dynamodb.types import TypeDeserializer
    deserializer = TypeDeserializer()
    with table.batch_writer() as writer:
        for item in transformed:
            writer.put_item(Item={key: deserializer.deserialize(value) for key, value in item.items()})
    if fingerprint(scan(dest_db, destination["BoardTableName"])) != fingerprint(transformed):
        raise RuntimeError("Destination board verification failed")
    if fingerprint(scan(source_db, source["BoardTableName"])) != fingerprint(source_items):
        raise RuntimeError("Source changed during migration; leave source frozen and investigate")
    settings(destination["ApiUrl"], args.destination_region, previous_enabled)
    print("Destination records verified; original posting state restored in destination.")
    print("Source remains frozen. Verify destination and publish new endpoints before retiring it.")


if __name__ == "__main__":
    main()
