"""Live AWS checks. Creates temporary notes and removes them through IAM admin API."""

import argparse
import json
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "sticky-board" / ".build" / "ApiFunction"))
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--cleanup-note")
    parser.add_argument("--month")
    args = parser.parse_args()
    created = []
    session = boto3.Session(region_name=args.region)

    def request(path, body=None, credential=None, method="POST", admin=False):
        url = args.api.rstrip("/") + path
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json", "Origin": "https://ryaneng.land"}
        if credential:
            headers["Authorization"] = "Bearer " + credential
        if admin:
            signed = AWSRequest(method=method, url=url, data=data, headers=headers)
            SigV4Auth(session.get_credentials().get_frozen_credentials(), "execute-api", args.region).add_auth(signed)
            headers = dict(signed.headers)
        try:
            with urlopen(Request(url, data=data, headers=headers, method=method), timeout=30) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def check(condition, name):
        if not condition:
            raise AssertionError(name)
        print("PASS", name)

    if args.cleanup_note:
        if not args.month:
            parser.error("--month is required for cleanup")
        status, result = request("/admin/notes/" + args.cleanup_note + "?month=" + args.month,
                                 {"requestId": str(uuid.uuid4())}, method="DELETE", admin=True)
        check(status == 200, f"IAM-authorized cleanup: {result}")
        return

    try:
        status, identity = request("/devices", {})
        check(status == 201 or status == 200, "Issue anonymous credential")
        credential = identity["credential"]
        status, snapshot = request("/board", credential=credential, method="GET")
        check(status == 200 and isinstance(snapshot["notes"], list), "Authenticated snapshot")
        month = snapshot["month"]
        check(isinstance(snapshot["resetAt"], (int, float)), "Authoritative reset timestamp")
        payload = {"month": month, "type": "text", "content": "Temporary AWS integration test",
                   "paper": "yellow", "x": 3250, "y": 3250, "rot": 12, "requestId": str(uuid.uuid4())}
        status, result = request("/notes", payload, credential)
        check(status in (200, 201), f"Create text note: {result}")
        note = result.get("note", result)
        created.append((month, note["id"]))
        status, retry = request("/notes", payload, credential)
        check(status in (200, 201) and retry.get("note", retry)["id"] == note["id"], "Exact retry is idempotent")
        status, _ = request("/notes", {**payload, "requestId": str(uuid.uuid4())}, credential)
        check(status == 409, "Monthly limit enforced")
        status, snapshot = request("/board", credential=credential, method="GET")
        check(any(n["id"] == note["id"] and n["deviceId"] == identity["deviceId"] for n in snapshot["notes"]), "Owner recognized in snapshot")
        status, moved = request("/notes/" + note["id"], {"month": month, "x": 3200, "y": 3250, "rot": -15,
                            "version": note["version"], "requestId": str(uuid.uuid4())}, credential, method="PATCH")
        check(status == 200, f"Versioned move: {status} {moved}")
        status, _ = request("/notes/" + note["id"], {"month": month, "x": 3000, "y": 3000, "rot": 0,
                            "version": note["version"], "requestId": str(uuid.uuid4())}, credential, method="PATCH")
        check(status == 409, "Stale move rejected")
        status, _ = request("/notes/" + note["id"] + "/bump", {"month": month, "version": note["version"] + 1,
                            "requestId": str(uuid.uuid4())}, credential)
        check(status == 409, "Same-day bump rejected")
        status, _ = request("/board", credential="invalid", method="GET")
        check(status == 401, "Invalid credential rejected")
        status, _ = request("/admin/notes/" + note["id"] + "?month=" + month,
                            {"requestId": str(uuid.uuid4())}, credential, method="DELETE")
        check(status in (401, 403), "Public credentials cannot moderate")
        status, revision = request("/revision", credential=credential, method="GET")
        check(status == 200 and revision["revision"] >= snapshot["revision"], "Revision endpoint")
        status, ticket = request("/connections/ticket", {}, credential)
        check(status in (200, 201) and ticket["ticket"] and ticket["url"].startswith("wss://"), "Single-use WebSocket ticket")
    finally:
        for month, note_id in created:
            status, result = request("/admin/notes/" + note_id + "?month=" + month,
                                     {"requestId": str(uuid.uuid4())}, method="DELETE", admin=True)
            check(status == 200, f"IAM-authorized cleanup: {result}")


if __name__ == "__main__":
    main()
