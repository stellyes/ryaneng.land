import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from botocore.exceptions import ClientError


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
with patch.dict(sys.modules, {"boto3": Mock()}):
    worker = importlib.import_module("convert_worker.app")
    submit = importlib.import_module("submit_job.app")
    status = importlib.import_module("job_status.app")
    request_access = importlib.import_module("request_access.app")


class OptimizerTests(unittest.TestCase):
    def test_real_resize_preserves_aspect_ratio(self):
        for width, height, expected in [
            (240, 120, "1080 540"),
            (120, 240, "540 1080"),
            (120, 120, "1080 1080"),
            (2160, 1080, "1080 540"),
        ]:
            with self.subTest(width=width, height=height), tempfile.TemporaryDirectory() as work_dir:
                source = Path(work_dir) / "source.ppm"
                source.write_bytes(f"P6\n{width} {height}\n255\n".encode() + bytes([30, 120, 60]) * width * height)
                output = worker._encode_target(str(source), "webp", work_dir, "optimize")
                dimensions = subprocess.check_output(["identify", "-format", "%w %h", output], text=True)
                self.assertEqual(dimensions, expected)
                self.assertEqual(Path(output).suffix, ".webp")

    def test_optimizer_command_orients_before_resizing_and_strips_metadata(self):
        with patch.object(worker, "_run") as run:
            worker._encode_target("/tmp/source.jpg", "webp", "/tmp", "optimize")
        command = run.call_args.args[0]
        self.assertLess(command.index("-auto-orient"), command.index("-resize"))
        self.assertIn("-strip", command)
        self.assertIn("1080x1080", command)
        self.assertEqual(command[1], "/tmp/source.jpg[0]")

    def test_conversion_command_is_unchanged(self):
        with patch.object(worker, "_run") as run:
            worker._encode_target("/tmp/source.png", "jpg", "/tmp")
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ["convert", "/tmp/source.png"])
        self.assertNotIn("-resize", command)

    def test_submit_forces_webp_and_records_owner(self):
        table = Mock()
        environment = {"RATE_LIMIT_TABLE": "rates", "JOBS_TABLE": "jobs", "CONVERT_WORKER_FUNCTION": "worker"}
        event = {"body": json.dumps({"key": "owner/source.png", "targetFormat": "pdf", "operation": "optimize"})}
        with patch.dict(os.environ, environment), patch.object(submit, "require_session", return_value={"ch": "owner"}), patch.object(submit.ratelimit, "check_and_increment", return_value=True), patch.object(submit._dynamodb, "Table", return_value=table), patch.object(submit._lambda, "invoke") as invoke:
            result = submit.handler(event, None)
        self.assertEqual(result["statusCode"], 200)
        job = json.loads(invoke.call_args.kwargs["Payload"])
        self.assertEqual(job["targetFormat"], "webp")
        self.assertEqual(job["operation"], "optimize")
        self.assertEqual(table.put_item.call_args.kwargs["Item"]["codeHash"], "owner")

    def test_unknown_operation_is_rejected(self):
        with patch.object(submit, "require_session", return_value={"ch": "owner"}):
            result = submit.handler({"body": '{"operation":"unexpected"}'}, None)
        self.assertEqual(result["statusCode"], 400)

    def test_other_owner_cannot_download_job(self):
        table = Mock()
        table.get_item.return_value = {"Item": {"codeHash": "other", "status": "DONE", "resultKey": "file.webp"}}
        with patch.dict(os.environ, {"JOBS_TABLE": "jobs"}), patch.object(status, "require_session", return_value={"ch": "owner"}), patch.object(status._dynamodb, "Table", return_value=table):
            result = status.handler({"pathParameters": {"id": "job"}}, None)
        self.assertEqual(result["statusCode"], 401)

    def test_worker_removes_temporary_files_on_success_and_failure(self):
        environment = {"UPLOADS_BUCKET": "uploads", "OUTPUTS_BUCKET": "outputs"}
        for fail in [False, True]:
            with self.subTest(fail=fail):
                directories = []
                def download(bucket, key, filename):
                    directories.append(Path(filename).parent)
                    Path(filename).write_bytes(b"test")
                with patch.dict(os.environ, environment), patch.object(worker._s3, "head_object", return_value={"ContentLength": 4}), patch.object(worker._s3, "download_file", side_effect=download), patch.object(worker, "_decode_to_intermediate", side_effect=lambda filename, extension, directory: filename), patch.object(worker, "_encode_target", side_effect=ValueError("internal secret") if fail else lambda filename, target, directory, operation: filename), patch.object(worker._s3, "upload_file"), patch.object(worker._s3, "delete_object") as delete, patch.object(worker, "_mark_job") as mark:
                    worker.handler({"jobId": "job", "sourceKey": "owner/source.png", "targetFormat": "webp", "operation": "optimize"}, None)
                self.assertTrue(directories)
                self.assertFalse(directories[0].exists())
                delete.assert_called_once()
                self.assertEqual(mark.call_args.kwargs["status"], "ERROR" if fail else "DONE")
                if fail:
                    self.assertNotIn("secret", mark.call_args.kwargs["error"])


class AccessRequestTests(unittest.TestCase):
    def test_delivery_rejection_returns_safe_service_unavailable(self):
        error = ClientError({"Error": {"Code": "MessageRejected", "Message": "Private delivery details"}}, "SendEmail")
        result = self.send_request(error)
        self.assertEqual(result["statusCode"], 503)
        self.assertNotIn("Private delivery details", result["body"])
        self.assertNotIn("request has been sent", result["body"])

    def test_successful_delivery_returns_confirmation(self):
        result = self.send_request(None)
        self.assertEqual(result["statusCode"], 200)
        self.assertIn("request has been sent", result["body"])

    def send_request(self, delivery_error):
        environment = {"RATE_LIMIT_TABLE": "rates", "SES_FROM_ADDRESS": "sender@example.test", "SES_TO_ADDRESS": "owner@example.test"}
        event = {"body": json.dumps({"name": "Test requester", "email": "requester@example.test", "captchaToken": "test"})}
        with patch.dict(os.environ, environment), patch.object(request_access, "is_dev_bypass", return_value=False), patch.object(request_access, "_get_recaptcha_secret", return_value="test"), patch.object(request_access, "verify_recaptcha", return_value=True), patch.object(request_access.ratelimit, "check_and_increment", return_value=True), patch.object(request_access._ses, "send_email", side_effect=delivery_error) as send:
            result = request_access.handler(event, None)
        send.assert_called_once()
        self.assertEqual(send.call_args.kwargs["ReplyToAddresses"], ["requester@example.test"])
        return result


if __name__ == "__main__":
    unittest.main()