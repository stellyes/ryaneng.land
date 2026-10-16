import copy
import importlib
import io
import json
import os
import re
import sys
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import rules

DESERIALIZER = TypeDeserializer()


def native(item):
    return {key: DESERIALIZER.deserialize(value) for key, value in item.items()}


def failure(code="ConditionalCheckFailedException"):
    return ClientError({"Error": {"Code": code, "Message": "mock failure"}}, "MockOperation")


class MemoryTable:
    name = "test-board"

    def __init__(self):
        self.items = {}
        self.query_pages = None
        self.page_size = 100

    def get_item(self, Key, **kwargs):
        item = self.items.get((Key["PK"], Key["SK"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def put_item(self, Item, **kwargs):
        self.items[(Item["PK"], Item["SK"])] = copy.deepcopy(Item)

    def query(self, **kwargs):
        if self.query_pages is not None:
            return self.query_pages.pop(0)
        pk = kwargs["ExpressionAttributeValues"][":pk"]
        prefix = kwargs["ExpressionAttributeValues"][":prefix"]
        items = sorted((copy.deepcopy(value) for (p, s), value in self.items.items()
                        if p == pk and s.startswith(prefix)), key=lambda item: item["SK"])
        start = kwargs.get("ExclusiveStartKey")
        if start:
            items = [item for item in items if item["SK"] > start["SK"]]
        page = items[:self.page_size]
        result = {"Items": page}
        if len(items) > self.page_size:
            result["LastEvaluatedKey"] = {"PK": pk, "SK": page[-1]["SK"]}
        return result


class MemoryClient:
    """An atomic mocked AWS transaction executor for the expressions used here."""
    def __init__(self, table):
        self.table = table
        self.calls = []
        self.conflicts = 0
        self.on_conflict = None

    def transact_write_items(self, TransactItems, **kwargs):
        self.calls.append(copy.deepcopy(TransactItems))
        if self.conflicts:
            self.conflicts -= 1
            if self.on_conflict:
                self.on_conflict()
            raise failure("TransactionCanceledException")
        working = copy.deepcopy(self.table.items)
        for action in TransactItems:
            kind, data = next(iter(action.items()))
            if re.search(r"(?<![:#\w])owner\b", data.get("ConditionExpression", "")):
                raise failure("ValidationException")
            item = native(data.get("Item", data.get("Key", {})))
            key = item["PK"], item["SK"]
            old = working.get(key)
            condition = data.get("ConditionExpression", "")
            values = native(data.get("ExpressionAttributeValues", {}))
            if condition == "attribute_not_exists(PK)" and old:
                raise failure("TransactionCanceledException")
            if condition == "revision = :old" and (not old or old["revision"] != values[":old"]):
                raise failure("TransactionCanceledException")
            if condition.startswith("version = :version"):
                assert data["ExpressionAttributeNames"]["#owner"] == "owner"
                if not old or old["version"] != values[":version"] or old["owner"] != values[":owner"]:
                    raise failure("TransactionCanceledException")
            if condition == "version = :old" and (not old or old["version"] != values[":old"]):
                raise failure("TransactionCanceledException")
            if "postingEnabled" in condition and old and old.get("postingEnabled") is False:
                raise failure("TransactionCanceledException")
            if condition.startswith("#state") and (
                    not old or old.get("state") != "ready" or old["owner"] != values[":owner"]
                    or old["expiresAt"] <= values[":now"]):
                raise failure("TransactionCanceledException")
            if kind == "Put":
                working[key] = item
            elif kind == "Delete":
                working.pop(key, None)
        self.table.items = working


class RulesTests(unittest.TestCase):
    def note(self, **changes):
        return dict(id="a", owner="mine", type="text", content="hello", paper="yellow",
                    x=0.5, y=0.5, rot=0, z=1, version=1, createdAt="now",
                    bumpedOn=None, **changes)

    def test_sat_rotation_separation_and_edge_touch(self):
        base = self.note()
        self.assertTrue(rules.overlaps(base, dict(base, rot=30)))
        self.assertFalse(rules.overlaps(base, dict(base, x=500)))
        self.assertFalse(rules.overlaps(base, dict(base, x=0.5 + 200)))
        self.assertTrue(rules.overlaps(base, dict(base, x=0.5 + 199)))

    def test_only_higher_other_note_covers(self):
        base = self.note()
        self.assertTrue(rules.covered(base, [dict(base, id="b", z=2)]))
        self.assertFalse(rules.covered(base, [dict(base, id="b", z=1)]))
        self.assertFalse(rules.covered(base, [dict(base, z=2)]))

    def test_geometry_matches_image_square(self):
        base = self.note()
        second = dict(base, id="b", type="photo", y=0.5 + 199)
        self.assertTrue(rules.overlaps(base, second))
        self.assertFalse(rules.overlaps(base, dict(second, y=0.5 + 200)))

    def test_positions_finite_and_types(self):
        for bad in (True, float("inf"), float("nan"), "0.5", None, -4001, 4001):
            with self.subTest(bad=bad), self.assertRaises(rules.APIError):
                rules.placement({"x": bad, "y": 0.5, "rot": 0})
        with self.assertRaises(rules.APIError):
            rules.placement({"x": 0.5, "y": 0.5, "rot": 181})

    def test_text_asset_and_request_validation(self):
        good = {"type": "text", "content": " hi ", "paper": "pink",
                "x": 0.5, "y": 0.5, "rot": 0}
        self.assertEqual(rules.validate_note(good)["content"], "hi")
        for content in ("", "  ", "x" * 257, "😀" * 129, 3):
            with self.assertRaises(rules.APIError):
                rules.validate_note(dict(good, content=content))
        with self.assertRaises(rules.APIError):
            rules.validate_note(dict(good, type="image", assetId="../escape"))
        with self.assertRaises(rules.APIError):
            rules.request_id({"requestId": "short"})
        with self.assertRaises(rules.APIError):
            rules.version_value({"version": True})

    def test_request_fingerprint_order_and_payload(self):
        self.assertEqual(rules.request_hash("POST", "/notes", {"a": 1, "b": 2}),
                         rules.request_hash("POST", "/notes", {"b": 2, "a": 1}))
        self.assertNotEqual(rules.request_hash("POST", "/notes", {"a": 1}),
                            rules.request_hash("POST", "/notes", {"a": 2}))

    def test_existing_frontend_world_geometry_and_image_types(self):
        for kind in ("draw", "photo", "image"):
            body = {"type": kind, "paper": "cream", "assetId": "a" * 32,
                    "x": -430, "y": 360, "rot": -90}
            result = rules.validate_note(body)
            self.assertEqual(result["type"], kind)
            self.assertEqual(result["x"], -430)
            self.assertEqual(result["rot"], -90)

    def test_month_pacific_rollover_and_dst(self):
        with patch("rules.pacific_now", return_value=datetime(
                2026, 10, 31, 23, 59, tzinfo=ZoneInfo("America/Los_Angeles"))):
            self.assertEqual(rules.current_month(), "2026-10")
            self.assertEqual(rules.month_value("current"), "2026-10")
            self.assertEqual(rules.clock()["resetAt"], int(datetime(
                2026, 11, 1, tzinfo=ZoneInfo("America/Los_Angeles")).timestamp() * 1000))
            with self.assertRaises(rules.APIError):
                rules.month_value("2026-09", writable=True)
        for value in ("2026-13", "2026-00", "../", 202610):
            with self.assertRaises(rules.APIError):
                rules.month_value(value)

    def test_ownership_is_private(self):
        note = self.note()
        self.assertEqual(rules.public_note(note, "mine")["deviceId"], "mine")
        public = rules.public_note(note, "stranger")
        self.assertIsNone(public["deviceId"])
        self.assertNotIn("owner", public)
        self.assertNotIn("PK", public)


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch("boto3.resource"), patch("boto3.client"):
            cls.app = importlib.import_module("app")

    def setUp(self):
        self.table = MemoryTable()
        self.client = MemoryClient(self.table)
        self.patches = [
            patch.object(self.app, "TABLE", self.table),
            patch.object(self.app, "CLIENT", self.client),
            patch.object(self.app, "S3", Mock()),
            patch.object(self.app, "identity_limit"),
            patch.object(self.app, "limit"),
            patch.object(self.app.time, "sleep"),
            patch.object(self.app, "CDN", "media.example"),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])
        self.month = rules.current_month()
        self.pk = f"BOARD#{self.month}"
        self.body = {"month": self.month, "type": "text", "content": "hello",
            "paper": "yellow", "x": 0.5, "y": 0.5, "rot": 0, "requestId": "request-0001"}

    def test_image_upload_uses_regional_endpoint(self):
        import boto3
        with patch("app.boto3.client", wraps=boto3.client), patch.dict(os.environ, {
            "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test",
        }):
            client = self.app.image_client("us-west-2")
            signed = client.generate_presigned_post(Bucket="test-sticky-images", Key="staged/test")
        self.assertEqual(signed["url"], "https://test-sticky-images.s3.us-west-2.amazonaws.com/")
        self.assertIn("/us-west-2/s3/aws4_request", signed["fields"]["x-amz-credential"])

    def mutate(self, body=None, method="POST", path="/notes", device="mine"):
        return self.app.mutation({}, method, path, body or self.body, device)

    def create(self):
        return self.mutate()["note"]

    def assert_code(self, code, call):
        with self.assertRaises(rules.APIError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)

    def test_create_transaction_revision_claim_durable_event_and_private_owner(self):
        note = self.create()
        self.assertEqual(note["version"], 1)
        self.assertEqual(note["bumpedOn"], rules.pacific_now().strftime("%Y-%m-%d"))
        self.assertEqual(self.table.items[(self.pk, "META")]["revision"], 1)
        self.assertIn((self.pk, "CLAIM#mine"), self.table.items)
        self.assertIn((self.pk, "EVENT#000000000001"), self.table.items)
        self.assertIn((self.pk, "REQUEST#mine#request-0001"), self.table.items)
        self.assertEqual(len(self.client.calls), 1)

    def test_exact_retry_and_hash_conflict(self):
        first = self.mutate()
        self.assertEqual(self.mutate(), first)
        self.assertEqual(len(self.client.calls), 1)
        self.assert_code("request_id_reused", lambda: self.mutate(dict(self.body, content="changed")))

    def test_lost_transaction_response_recovers_durable_result(self):
        original = self.client.transact_write_items

        def lost_response(**kwargs):
            original(**kwargs)
            raise failure("TransactionCanceledException")
        self.client.transact_write_items = lost_response
        result = self.mutate()
        self.assertEqual(result["revision"], 1)
        self.assertEqual(len(self.client.calls), 1)

    def test_cas_conflict_retries_without_duplicate_note(self):
        self.client.conflicts = 2
        result = self.mutate()
        self.assertEqual(result["revision"], 1)
        self.assertEqual(len(self.client.calls), 3)
        self.assertEqual(len([key for key in self.table.items if key[1].startswith("NOTE#")]), 1)

    def test_nonconditional_transaction_failure_is_not_hidden(self):
        self.client.transact_write_items = Mock(side_effect=ClientError({
            "Error": {"Code": "TransactionCanceledException", "Message": "failure"},
            "CancellationReasons": [{"Code": "ProvisionedThroughputExceeded"}]}, "Transaction"))
        with self.assertRaises(ClientError):
            self.mutate()

    def test_one_note_per_month(self):
        self.create()
        self.assert_code("monthly_limit", lambda: self.mutate(
            dict(self.body, requestId="request-0002")))

    def test_board_size_guard_and_layer_ceiling(self):
        self.table.put_item(Item={"PK": self.pk, "SK": "META", "revision": 1,
                                  "maxZ": 1, "noteCount": self.app.MAX_NOTES})
        self.assert_code("board_full", lambda: self.mutate())
        self.table.items[(self.pk, "META")].update(noteCount=0, maxZ=rules.MAX_Z)
        self.assert_code("layer_limit", lambda: self.mutate())

    def test_move_owned_version_and_idempotency(self):
        note = self.create()
        body = dict(month=self.month, x=0.4, y=0.4, rot=5, version=1, requestId="move-0001")
        result = self.mutate(body, "PATCH", f"/notes/{note['id']}")
        self.assertEqual(result["note"]["version"], 2)
        self.assertEqual(result["note"]["z"], 1)
        action = self.client.calls[-1][0]["Put"]
        self.assertEqual(action["ExpressionAttributeNames"], {"#owner": "owner"})
        self.assertIn("#owner = :owner", action["ConditionExpression"])
        retry = self.mutate(body, "PATCH", f"/notes/{note['id']}")
        self.assertEqual(json.loads(json.dumps(retry, default=self.app.wire)),
                         json.loads(json.dumps(result, default=self.app.wire)))
        self.assert_code("version_conflict", lambda: self.mutate(
            dict(body, requestId="move-0002"), "PATCH", f"/notes/{note['id']}"))
        self.assert_code("not_owner", lambda: self.mutate(
            dict(body, version=2, requestId="move-0003"), "PATCH",
            f"/notes/{note['id']}", "stranger"))

    def test_bump_requires_coverage_and_once_per_day_including_post(self):
        note = self.create()
        body = dict(month=self.month, version=1, requestId="bump-0001")
        path = f"/notes/{note['id']}/bump"
        self.assert_code("bump_daily_limit", lambda: self.mutate(body, "POST", path))
        raw = self.table.items[(self.pk, f"NOTE#{note['id']}")]
        raw["bumpedOn"] = "2000-01-01"
        self.assert_code("not_covered", lambda: self.mutate(body, "POST", path))
        self.mutate(dict(self.body, requestId="other-0001"), device="other")
        result = self.mutate(body, "POST", path)
        self.assertEqual(result["note"]["z"], 3)
        self.assertEqual(result["note"]["version"], 2)
        self.assert_code("bump_daily_limit", lambda: self.mutate(
            dict(body, version=2, requestId="bump-0002"), "POST", path))

    def test_kill_switch_blocks_all_mutations_and_retries_remain_exact(self):
        first = self.mutate()
        self.table.put_item(Item={"PK": "SETTINGS", "SK": "META", "postingEnabled": False})
        self.assertEqual(self.mutate(), first)
        self.assert_code("posting_disabled", lambda: self.mutate(
            dict(self.body, requestId="request-0002"), device="other"))
        self.assert_code("posting_disabled", lambda: self.app.upload({}, "mine"))

    def test_kill_switch_race_transaction_enforces_condition(self):
        self.client.conflicts = 1
        self.client.on_conflict = lambda: self.table.put_item(Item={
            "PK": "SETTINGS", "SK": "META", "postingEnabled": False})
        self.assert_code("posting_disabled", lambda: self.mutate())
        self.assertNotIn((self.pk, "META"), self.table.items)

    def test_admin_delete_iam_required_revision_and_claim_retained(self):
        note = self.create()
        event = {"requestContext": {"authorizer": {"iam": {"userArn": "test"}}},
                 "queryStringParameters": {"month": self.month}}
        result = self.app.admin(event, "DELETE", f"/admin/notes/{note['id']}",
                                {"requestId": "delete-0001"})
        self.assertEqual(result["revision"], 2)
        self.assertNotIn((self.pk, f"NOTE#{note['id']}"), self.table.items)
        self.assertIn((self.pk, "CLAIM#mine"), self.table.items)
        self.assertEqual(self.table.items[(self.pk, "META")]["noteCount"], 0)
        self.table.put_item(Item={"PK": f"DEVICE#{rules.digest('test-credential')}",
            "SK": "META", "deviceId": "mine"})
        snapshot_event = {"rawPath": "/board",
            "headers": {"Authorization": "Bearer test-credential"},
            "requestContext": {"http": {"method": "GET"}}}
        snapshot = json.loads(self.app.handler(snapshot_event, None)["body"])
        self.assertTrue(snapshot["hasPosted"])
        self.assertEqual(snapshot["notes"], [])
        snapshot_event["queryStringParameters"] = {"revision": "2"}
        unchanged = json.loads(self.app.handler(snapshot_event, None)["body"])
        self.assertTrue(unchanged["hasPosted"])
        self.assertTrue(unchanged["unchanged"])
        self.assert_code("iam_required", lambda: self.app.admin(
            {}, "PUT", "/admin/settings", {"postingEnabled": False}))

    def test_snapshot_pagination_and_reread_revision(self):
        for index in range(3):
            self.table.put_item(Item={"PK": self.pk, "SK": f"NOTE#{index}", "id": str(index)})
        self.table.page_size = 1
        meta, notes = self.app.snapshot(self.month)
        self.assertEqual(len(notes), 3)
        self.assertEqual(meta["revision"], 0)
        with patch.object(self.app, "read_meta", side_effect=[
                {"revision": 1}, {"revision": 2}, {"revision": 2}, {"revision": 2}]):
            meta, notes = self.app.snapshot(self.month)
            self.assertEqual(meta["revision"], 2)

    def test_snapshot_contention_bounded(self):
        with patch.object(self.app, "read_meta", side_effect=[
                {"revision": index} for index in range(8)]):
            self.assert_code("board_busy", lambda: self.app.snapshot(self.month))

    def test_authenticated_get_revision_and_unchanged_clock(self):
        event = {"headers": {"Authorization": "Bearer opaque-credential",
                             "Origin": "http://127.0.0.1:8765"},
            "requestContext": {"http": {"method": "GET", "sourceIp": "127.0.0.1"}},
            "rawPath": "/board", "queryStringParameters": {"revision": "0"}}
        self.table.put_item(Item={"PK": f"DEVICE#{rules.digest('opaque-credential')}",
                                 "SK": "META", "deviceId": "mine"})
        reply = self.app.handler(event, None)
        payload = json.loads(reply["body"])
        self.assertTrue(payload["unchanged"])
        self.assertEqual(payload["deviceId"], "mine")
        self.assertFalse(payload["hasPosted"])
        self.assertIn("serverNow", payload)
        self.assertGreater(payload["resetAt"], payload["serverNow"])
        self.assertEqual(reply["headers"]["Access-Control-Allow-Origin"],
                         "http://127.0.0.1:8765")
        event["rawPath"] = "/revision"
        self.assertNotIn("notes", json.loads(self.app.handler(event, None)["body"]))

    def test_credential_hashed_and_cloud_failure_explicit(self):
        self.table.put_item = Mock()
        event = {"rawPath": "/devices", "requestContext": {
            "requestId": "trace-id", "http": {"method": "POST", "sourceIp": "192.0.2.1"}}}
        reply = self.app.handler(event, None)
        payload = json.loads(reply["body"])
        item = self.table.put_item.call_args.kwargs["Item"]
        self.assertNotIn(payload["credential"], json.dumps(item))
        self.assertEqual(item["PK"], f"DEVICE#{rules.digest(payload['credential'])}")
        self.table.put_item.side_effect = failure("AccessDeniedException")
        with self.assertLogs(level="ERROR") as logs:
            reply = self.app.handler(event, None)
        self.assertEqual(reply["statusCode"], 503)
        self.assertIn("AccessDeniedException", "\n".join(logs.output))
        self.assertNotIn("192.0.2.1", "\n".join(logs.output))

    def test_ip_digest_not_raw_and_rate_conditional(self):
        self.assertEqual(self.app.ip_hash({"requestContext": {
            "http": {"sourceIp": "192.0.2.1"}}}), rules.digest("192.0.2.1"))
        fake = Mock()
        fake.update_item.side_effect = failure()
        # Exercise the original limiter (the per-test mock is temporarily stopped).
        self.patches[4].stop()
        with patch.object(self.app, "TABLE", fake):
            self.assert_code("rate_limited", lambda: self.app.limit("device:hashed", 5))
        kwargs = fake.update_item.call_args.kwargs
        self.assertEqual(kwargs["ExpressionAttributeValues"][":maximum"], 5)
        self.assertIn("hits < :maximum", kwargs["ConditionExpression"])

    def test_finalize_strips_metadata_resizes_and_deletes_staging(self):
        asset_id = "a" * 32
        asset = {"PK": f"ASSET#{asset_id}", "SK": "META", "owner": "mine",
                 "state": "staged", "expiresAt": rules.pacific_now().timestamp() + 86400}
        table = Mock()
        table.get_item.return_value = {"Item": asset}
        source = io.BytesIO()
        Image.new("RGB", (800, 600), "red").save(source, "PNG")
        self.app.S3.get_object.return_value = {"Body": io.BytesIO(source.getvalue())}
        with patch.object(self.app, "TABLE", table):
            result = self.app.finalize({}, "mine", asset_id)
        self.assertEqual(result, {"assetId": asset_id})
        uploaded = self.app.S3.put_object.call_args.kwargs
        self.assertEqual(uploaded["Key"], f"published/{asset_id}.webp")
        with Image.open(io.BytesIO(uploaded["Body"])) as clean:
            self.assertEqual(clean.size, (480, 480))
            self.assertEqual(clean.format, "WEBP")
            self.assertNotIn("exif", clean.info)
        self.app.S3.delete_object.assert_called_once()
        update = table.update_item.call_args.kwargs
        self.assertEqual(update["ExpressionAttributeNames"]["#owner"], "owner")
        self.assertIn("#owner = :owner", update["ConditionExpression"])

    def test_finalize_invalid_and_oversized_images(self):
        asset_id = "a" * 32
        table = Mock()
        table.get_item.return_value = {"Item": {"PK": f"ASSET#{asset_id}",
            "owner": "mine", "state": "staged", "expiresAt": 9999999999}}
        for data, code in ((b"not an image", "invalid_image"),
                           (b"x" * 1048577, "image_too_large")):
            self.app.S3.get_object.return_value = {"Body": io.BytesIO(data)}
            with patch.object(self.app, "TABLE", table):
                self.assert_code(code, lambda: self.app.finalize({}, "mine", asset_id))

    def test_upload_presigned_post_limits(self):
        self.app.S3.generate_presigned_post.return_value = {"url": "https://s3", "fields": {"key": "x"}}
        result = self.app.upload({}, "mine")
        args = self.app.S3.generate_presigned_post.call_args.kwargs
        self.assertIn(["content-length-range", 1, 1048576], args["Conditions"])
        self.assertEqual(args["ExpiresIn"], 300)
        self.assertEqual(result["maxBytes"], 1048576)

    def test_ticket_single_use_conditional_expiry_and_origin(self):
        event = {"requestContext": {"routeKey": "$connect", "connectionId": "connection"},
                 "headers": {"Origin": self.app.ORIGIN},
                 "queryStringParameters": {"ticket": "opaque-ticket"}}
        table, connections = Mock(), Mock()
        table.delete_item.return_value = {"Attributes": {"deviceId": "mine"}}
        with patch.object(self.app, "TABLE", table), patch.object(self.app, "CONNECTIONS", connections):
            self.assertEqual(self.app.websocket(event)["statusCode"], 200)
            condition = table.delete_item.call_args.kwargs
            self.assertEqual(condition["ConditionExpression"], "expiresAt > :now")
            self.assertNotIn("opaque-ticket", json.dumps(condition))
            table.delete_item.side_effect = failure()
            self.assert_code("invalid_ticket", lambda: self.app.websocket(event))
            event["headers"]["Origin"] = "https://hostile.example"
            self.assert_code("invalid_origin", lambda: self.app.websocket(event))
        expiry = connections.put_item.call_args.kwargs["Item"]["expiresAt"]
        self.assertLessEqual(expiry - self.app.time.time(), 7200)

    def test_session_cap_conditional_slots_and_reuse(self):
        table = Mock()
        table.put_item.side_effect = [failure(), failure(), None]
        with patch.object(self.app, "TABLE", table):
            key = self.app.acquire_session("mine", "connection")
            self.assertEqual(key["SK"], "SLOT#2")
            self.assertEqual(table.put_item.call_count, 3)
            table.put_item.side_effect = failure()
            self.assert_code("session_limit", lambda: self.app.acquire_session("mine", "other"))
            self.app.release_session(key, "connection")
        self.assertEqual(table.delete_item.call_args.kwargs["ConditionExpression"],
                         "connectionId = :id")

    def test_ticket_returns_base_url_for_frontend_and_persists_hash_only(self):
        with patch.object(self.app, "WS_URL", "wss://ws.example/live"):
            result = self.app.ticket({}, "mine")
        self.assertEqual(result["url"], "wss://ws.example/live")
        self.assertNotIn("?ticket=", result["url"])
        self.assertIn((f"TICKET#{rules.digest(result['ticket'])}", "META"), self.table.items)
        item = self.table.items[(f"TICKET#{rules.digest(result['ticket'])}", "META")]
        self.assertNotIn(result["ticket"], json.dumps(item))

    def test_heartbeat_rollover_does_not_extend_lease(self):
        table, gateway = Mock(), Mock()
        table.get_item.return_value = {"Item": {
            "connectionId": "connection", "month": "2000-01", "expiresAt": 9999999999}}
        event = {"requestContext": {"routeKey": "heartbeat", "connectionId": "connection",
            "domainName": "ws.example", "stage": "live"}}
        with patch.object(self.app, "CONNECTIONS", table), patch.object(
                self.app.boto3, "client", return_value=gateway):
            result = self.app.websocket(event)
        self.assertEqual(result["statusCode"], 200)
        self.assertNotIn("expiresAt", table.update_item.call_args.kwargs["UpdateExpression"])
        sent = json.loads(gateway.post_to_connection.call_args.kwargs["Data"])
        self.assertEqual(sent["month"], rules.current_month())
        self.assertEqual(sent["revision"], 0)

    def test_invalid_encoded_body_and_nan_return_400(self):
        event = {"rawPath": "/devices", "body": "%%%not-base64", "isBase64Encoded": True,
            "requestContext": {"http": {"method": "POST", "sourceIp": "192.0.2.1"}}}
        self.assertEqual(self.app.handler(event, None)["statusCode"], 400)
        event.update(body='{"x":NaN}', isBase64Encoded=False)
        self.assertEqual(self.app.handler(event, None)["statusCode"], 400)

    def test_finalized_image_owner_and_expiry_guard(self):
        body = dict(self.body, type="image", assetId="a" * 32)
        self.table.put_item(Item={"PK": f"ASSET#{'a' * 32}", "SK": "META",
            "owner": "other", "state": "ready", "expiresAt": 9999999999})
        self.assert_code("invalid_asset", lambda: self.mutate(body))
        asset = self.table.items[(f"ASSET#{'a' * 32}", "META")]
        asset.update(owner="mine", expiresAt=0)
        self.assert_code("invalid_asset", lambda: self.mutate(body))
        asset.update(expiresAt=9999999999)
        result = self.mutate(body)
        self.assertEqual(result["note"]["content"],
                         f"https://media.example/published/{'a' * 32}.webp")
        self.assertNotIn("assetId", result["note"])
        asset_check = self.client.calls[-1][2]["ConditionCheck"]
        self.assertEqual(asset_check["ExpressionAttributeNames"]["#owner"], "owner")
        self.assertIn("#owner = :owner", asset_check["ConditionExpression"])


class BroadcastTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch("boto3.resource"), patch("boto3.client"):
            cls.module = importlib.import_module("broadcast")

    def record(self, sk="EVENT#000000000001", sequence="123", event="INSERT"):
        return {"eventName": event, "dynamodb": {"SequenceNumber": sequence, "NewImage": {
            "SK": {"S": sk}, "month": {"S": "2026-10"}, "revision": {"N": "1"}}}}

    def test_durable_events_only_and_failure_batch_retry(self):
        with patch.object(self.module, "broadcast", side_effect=[None, RuntimeError("cloud")]) as send:
            result = self.module.handler({"Records": [
                self.record("NOTE#a"), self.record(event="MODIFY"),
                self.record(), self.record(sequence="124")]}, None)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "124"}]})

    def test_paginates_bounded_connections(self):
        table = Mock()
        table.query.side_effect = [
            {"Items": [{"connectionId": "1", "expiresAt": 9999999999}],
             "LastEvaluatedKey": {"connectionId": "1"}},
            {"Items": [{"connectionId": "2", "expiresAt": 9999999999}]}]
        gateway = Mock()
        with patch.object(self.module, "TABLE", table), patch.object(self.module, "GATEWAY", gateway):
            self.module.broadcast("2026-10", 7)
        self.assertEqual(gateway.post_to_connection.call_count, 2)
        self.assertEqual(table.query.call_args.kwargs["ExclusiveStartKey"], {"connectionId": "1"})
        self.assertEqual(table.query.call_args.kwargs["Limit"], 100)
        self.assertEqual(json.loads(gateway.post_to_connection.call_args.kwargs["Data"]),
                         {"month": "2026-10", "revision": 7})

    def test_gone_and_expired_purged_other_failures_raise(self):
        table, gateway = Mock(), Mock()
        with patch.object(self.module, "TABLE", table), patch.object(self.module, "GATEWAY", gateway):
            self.module.send({"connectionId": "old", "expiresAt": 0}, b"{}")
            gateway.post_to_connection.assert_not_called()
            gateway.post_to_connection.side_effect = failure("GoneException")
            self.module.send({"connectionId": "gone", "expiresAt": 9999999999}, b"{}")
            self.assertEqual(table.delete_item.call_count, 2)
            gateway.post_to_connection.side_effect = failure("LimitExceededException")
            with self.assertRaises(ClientError):
                self.module.send({"connectionId": "retry", "expiresAt": 9999999999}, b"{}")


if __name__ == "__main__":
    unittest.main()
