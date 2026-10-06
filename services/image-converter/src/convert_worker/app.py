"""Convert-worker Lambda (container image).

Invoked asynchronously by submit_job with {"jobId", "sourceKey", "targetFormat"}.
Downloads the source from S3, rasterizes/decodes it to an intermediate image
with whichever delegate tool fits the source format, re-encodes to the
requested target with ImageMagick (or heif-enc for HEIC/HEIF targets),
uploads the result, and records the outcome in the Jobs table.

No secrets, no user input reaches a shell with attacker-controlled strings:
every subprocess call uses a list of args (no shell=True) and all file paths
are ones we generated ourselves in /tmp.
"""
import os
import subprocess
import tempfile
import time
import uuid

import boto3

from common.formats import (
    HEIC_EXTENSIONS,
    IM_CODER_FOR_TARGET,
    MAX_UPLOAD_BYTES,
    RAW_EXTENSIONS,
    VECTOR_DOC_EXTENSIONS,
)

_s3 = boto3.client("s3")
_dynamodb = boto3.resource("dynamodb")

TMP_DIR = "/tmp"
SUBPROCESS_TIMEOUT = 50  # seconds; Lambda timeout should be set a bit higher


def _run(args):
    return subprocess.run(
        args,
        cwd=TMP_DIR,
        capture_output=True,
        timeout=SUBPROCESS_TIMEOUT,
        check=True,
    )


def _mark_job(job_id, **fields):
    table = _dynamodb.Table(os.environ["JOBS_TABLE"])
    update_expr = "SET " + ", ".join(f"#{k} = :{k}" for k in fields)
    table.update_item(
        Key={"jobId": job_id},
        UpdateExpression=update_expr,
        ExpressionAttributeNames={f"#{k}": k for k in fields},
        ExpressionAttributeValues={f":{k}": v for k, v in fields.items()},
    )


def _decode_to_intermediate(source_path: str, source_ext: str, work_dir: str) -> str:
    """Normalizes any supported source format down to a plain raster file
    ImageMagick can read without any special delegate, returning its path."""
    work_id = uuid.uuid4().hex

    if source_ext in VECTOR_DOC_EXTENSIONS:
        intermediate = os.path.join(work_dir, f"{work_id}.png")
        if source_ext == "svg":
            _run(["rsvg-convert", "-o", intermediate, source_path])
        else:  # pdf, eps, ai (ai files with PDF compatibility open fine via gs)
            _run([
                "gs", "-dBATCH", "-dNOPAUSE", "-dSAFER",
                "-sDEVICE=png16m", "-r200",
                "-dFirstPage=1", "-dLastPage=1",
                f"-o{intermediate}", source_path,
            ])
        return intermediate

    if source_ext in RAW_EXTENSIONS:
        _run(["dcraw", "-w", "-T", source_path])
        tiff_path = os.path.splitext(source_path)[0] + ".tiff"
        return tiff_path

    if source_ext in HEIC_EXTENSIONS:
        intermediate = os.path.join(work_dir, f"{work_id}.png")
        _run(["heif-convert", source_path, intermediate])
        return intermediate

    # Already a plain raster format ImageMagick understands directly.
    return source_path


def _encode_target(intermediate_path: str, target_format: str, work_dir: str, operation: str = "convert") -> str:
    output_path = os.path.join(work_dir, f"{uuid.uuid4().hex}.{target_format}")

    if operation == "optimize":
        _run([
            "convert", f"{intermediate_path}[0]", "-auto-orient",
            "-resize", "1080x1080", "-strip", "-quality", "80",
            f"webp:{output_path}",
        ])
        return output_path

    if target_format in HEIC_EXTENSIONS:
        _run(["heif-enc", "-o", output_path, intermediate_path])
        return output_path

    coder = IM_CODER_FOR_TARGET[target_format]
    _run(["convert", intermediate_path, f"{coder}:{output_path}"])
    return output_path


def handler(event, context):
    job_id = event["jobId"]
    source_key = event["sourceKey"]
    target_format = event["targetFormat"]
    source_ext = source_key.rsplit(".", 1)[-1].lower()

    try:
        head = _s3.head_object(Bucket=os.environ["UPLOADS_BUCKET"], Key=source_key)
        if head["ContentLength"] > MAX_UPLOAD_BYTES:
            raise ValueError("Uploaded file exceeds the size limit.")

        with tempfile.TemporaryDirectory(dir=TMP_DIR) as work_dir:
            local_source = os.path.join(work_dir, f"source.{source_ext}")
            _s3.download_file(os.environ["UPLOADS_BUCKET"], source_key, local_source)

            intermediate = _decode_to_intermediate(local_source, source_ext, work_dir)
            output_path = _encode_target(intermediate, target_format, work_dir, event.get("operation", "convert"))

            result_key = f"{job_id}/output.{target_format}"
            _s3.upload_file(output_path, os.environ["OUTPUTS_BUCKET"], result_key)

        _mark_job(job_id, status="DONE", resultKey=result_key, finishedAt=int(time.time()))
    except subprocess.CalledProcessError as err:
        _mark_job(
            job_id,
            status="ERROR",
            error="This image could not be processed. It may be unsupported or damaged.",
        )
    except subprocess.TimeoutExpired:
        _mark_job(job_id, status="ERROR", error="Conversion timed out.")
    except Exception:
        _mark_job(job_id, status="ERROR", error="Image processing failed.")
    finally:
        # Best-effort cleanup of anything left in /tmp for this invocation.
        try:
            _s3.delete_object(Bucket=os.environ["UPLOADS_BUCKET"], Key=source_key)
        except Exception:
            pass
