#!/usr/bin/env python3
"""Admin utility: mint a new access code and store its hash in DynamoDB.

Run this locally (with AWS credentials configured) after deploying the stack.
The raw code is printed once -- copy it into the email you send the
requester. It is never stored in plaintext anywhere.

Usage:
  python generate_access_code.py --table image-converter-AccessCodes \
      --max-uses 20 --expires-days 30 --label "jane@example.com"
"""
import argparse
import secrets
import sys
import time

import boto3

sys.path.insert(0, "../src")
from common.security import hash_code  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--table", required=True, help="AccessCodes DynamoDB table name")
    parser.add_argument("--max-uses", type=int, default=20, help="0 = unlimited uses")
    parser.add_argument("--expires-days", type=int, default=30, help="0 = never expires")
    parser.add_argument("--label", default="", help="Note for your own reference (e.g. requester email)")
    args = parser.parse_args()

    raw_code = "-".join(secrets.token_hex(2) for _ in range(3))  # e.g. a1b2-c3d4-e5f6
    code_hash = hash_code(raw_code)

    item = {
        "codeHash": code_hash,
        "maxUses": args.max_uses,
        "uses": 0,
        "disabled": False,
        "label": args.label,
        "createdAt": int(time.time()),
    }
    if args.expires_days > 0:
        item["expiresAt"] = int(time.time()) + args.expires_days * 86400

    boto3.resource("dynamodb").Table(args.table).put_item(Item=item)

    print(f"Access code (send this to the requester): {raw_code}")
    print(f"Stored hash: {code_hash}")


if __name__ == "__main__":
    main()
