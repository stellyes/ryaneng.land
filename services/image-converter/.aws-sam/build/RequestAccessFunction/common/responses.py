import json

DEFAULT_HEADERS = {
    "Content-Type": "application/json",
}


def response(status_code: int, body: dict, extra_headers: dict = None):
    headers = dict(DEFAULT_HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body),
    }


def ok(body: dict):
    return response(200, body)


def bad_request(message: str):
    return response(400, {"error": message})


def unauthorized(message: str = "Unauthorized"):
    return response(401, {"error": message})


def too_many_requests(message: str = "Rate limit exceeded, try again later."):
    return response(429, {"error": message})


def server_error(message: str = "Internal server error"):
    return response(500, {"error": message})
