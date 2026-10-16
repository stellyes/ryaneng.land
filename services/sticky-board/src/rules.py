"""Pure validation and board geometry shared by API and tests."""
import hashlib
import json
import math
import re
from datetime import datetime
from zoneinfo import ZoneInfo

NOTE_SIZE = 200
WORLD_LIMIT = 4000
PAPERS = {"yellow", "pink", "blue", "green", "cream", "purple", "peach"}
MAX_Z = 1_000_000


class APIError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


def pacific_now():
    return datetime.now(ZoneInfo("America/Los_Angeles"))


def current_month():
    return pacific_now().strftime("%Y-%m")


def clock():
    now = pacific_now()
    year, month = (now.year + 1, 1) if now.month == 12 else (now.year, now.month + 1)
    reset = datetime(year, month, 1, tzinfo=ZoneInfo("America/Los_Angeles"))
    return {"serverNow": int(now.timestamp() * 1000), "resetAt": int(reset.timestamp() * 1000)}


def month_value(value, writable=False):
    month = current_month() if value in (None, "current") else value
    if not isinstance(month, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise APIError(400, "invalid_month", "Month must be YYYY-MM or current.")
    if writable and month != current_month():
        raise APIError(409, "month_changed", "Only the current Pacific month is writable.")
    return month


def number(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise APIError(400, "invalid_input", f"{name} must be a number.")
    if not math.isfinite(value) or not low <= value <= high:
        raise APIError(400, "invalid_input", f"{name} is outside its allowed range.")
    return value


def placement(body):
    return {key: number(body.get(key), low, high, key) for key, low, high in (
        ("x", -WORLD_LIMIT, WORLD_LIMIT), ("y", -WORLD_LIMIT, WORLD_LIMIT),
        ("rot", -180, 180))}


def request_id(body):
    value = body.get("requestId")
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", value):
        raise APIError(400, "invalid_request_id", "requestId must be 8-100 URL-safe characters.")
    return value


def version_value(body):
    value = body.get("version")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise APIError(400, "invalid_version", "version must be a positive integer.")
    return value


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def request_hash(method, path, body):
    try:
        return digest(json.dumps([method, path, body], sort_keys=True, separators=(",", ":"),
                                 ensure_ascii=False, allow_nan=False))
    except (UnicodeError, ValueError) as error:
        raise APIError(400, "invalid_input", "Request contains invalid characters or numbers.") from error


def validate_note(body):
    note = placement(body)
    kind = body.get("type")
    paper = body.get("paper")
    if kind not in {"text", "image", "draw", "photo"} or paper not in PAPERS:
        raise APIError(400, "invalid_input", "Invalid note type or paper.")
    note.update(type=kind, paper=paper)
    if kind == "text":
        content = body.get("content")
        if not isinstance(content, str) or not content.strip():
            raise APIError(400, "invalid_content", "Text must contain 1-256 UTF-16 units.")
        try:
            if len(content.encode("utf-16-le")) // 2 > 256:
                raise APIError(400, "invalid_content", "Text must contain 1-256 UTF-16 units.")
        except UnicodeError as error:
            raise APIError(400, "invalid_content", "Text contains invalid Unicode.") from error
        note["content"] = content.strip()
    else:
        asset = body.get("assetId")
        if not isinstance(asset, str) or not re.fullmatch(r"[a-f0-9]{32}", asset):
            raise APIError(400, "invalid_asset", "A finalized assetId is required.")
        note["assetId"] = asset
    return note


def corners(note):
    width, height = NOTE_SIZE, NOTE_SIZE
    x, y = float(note["x"]), float(note["y"])
    angle = math.radians(float(note["rot"]))
    cos, sin = math.cos(angle), math.sin(angle)
    return [(x + dx * cos - dy * sin, y + dx * sin + dy * cos)
            for dx, dy in ((-width / 2, -height / 2), (width / 2, -height / 2),
                           (width / 2, height / 2), (-width / 2, height / 2))]


def overlaps(first, second):
    a, b = corners(first), corners(second)
    for polygon in (a, b):
        for index in range(4):
            p, q = polygon[index], polygon[(index + 1) % 4]
            axis = (-(q[1] - p[1]), q[0] - p[0])
            left = [point[0] * axis[0] + point[1] * axis[1] for point in a]
            right = [point[0] * axis[0] + point[1] * axis[1] for point in b]
            if min(max(left), max(right)) - max(min(left), min(right)) <= 1e-6:
                return False
    return True


def covered(note, notes):
    return any(other["id"] != note["id"] and int(other["z"]) > int(note["z"])
               and overlaps(note, other) for other in notes)


def public_note(note, device_id):
    fields = ("id", "type", "content", "paper", "x", "y", "rot", "z",
              "version", "createdAt", "bumpedOn")
    result = {key: note.get(key) for key in fields}
    result["deviceId"] = device_id if note["owner"] == device_id else None
    return result
