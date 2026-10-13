# Sticky-board backend

Self-contained AWS SAM service. Python 3.12 **x86_64** Lambda, HTTP API, WebSocket
API, two on-demand DynamoDB tables, private S3, CloudFront OAC. No frontend,
workflow, deployment, access keys, scheduled monthly jobs, or signing-secret
service is included.

## Build and validate (Windows, without Docker)

Use an already configured Python interpreter. From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File services\sticky-board\build.ps1
sam validate --lint --template-file services\sticky-board\.build\template.yaml --region us-west-2
& "C:\Users\BHAM CSR\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m unittest discover -s services\sticky-board\tests -v
```

`build.ps1` uses the Python 3.14 host **only to download/install Linux CPython
3.12 manylinux2014 x86_64 wheels** into `.build\ApiFunction`. It does not execute
Linux extension modules on Windows and does not deploy anything. Pillow is
pinned in `src\requirements.txt`; the manifest includes boto3 and timezone data.
The resulting `.build\template.yaml` is directly usable with `sam package` or
`sam deploy --template-file ...`. It is not necessary to run `sam build` again
on those prepared artifacts. On Linux with Python and `make`, the source
template's SAM custom Makefile supports `sam build` without Docker and performs
the same explicit wheel selection. `build.ps1 -Python <absolute-path>` overrides
the host interpreter.

Tests need `requirements-dev.txt` installed in the selected host environment if
imports are missing. They use mocked AWS clients only; no AWS credentials or
cloud resources are needed. Host tests use Pillow 12 (Python 3.14 wheels), whereas
Lambda artifacts use Pillow 11.3 (Python 3.12 wheels).

The owner/operator deploys stack **sticky-board-west** to **us-west-2** using their existing AWS login and
`CAPABILITY_IAM`; no IAM access keys are created. Parameters:
`SiteOrigin=https://ryaneng.land`, `LocalOrigin=http://127.0.0.1:8765`,
`MaxNotes=500`, `ReservedConcurrency=0`, `BroadcastReservedConcurrency=0`.
`NotificationEmail` defaults to empty, creating no budget or email subscriptions.
Zero omits the corresponding Lambda reserved-concurrency property, allowing
deployment into low-quota accounts that must retain ten unreserved executions.
If the account quota permits, set API reservation10 and broadcaster2 explicitly.
Production and preview origins, plus `http://localhost:5500` and`http://127.0.0.1:5500` for VS Code Live Server, are allowed by HTTP API,
S3 presigned POST CORS and WebSocket `$connect`. Remove the local origin from
the template and environment if local browser testing is no longer required.
Outputs: `ApiUrl`, `WebSocketUrl`, `MediaUrl`, table/bucket names, distribution ID,
failure queue URL, and `AdminInvokeResource`.

## Regional migration

The active deployment is `sticky-board-west` in `us-west-2`. The former
`sticky-board` stack in `us-east-1`, its retained table and image bucket, and
its unused SAM packaging stack have been retired. CloudFront and AWS Budgets
are global services; the new distribution serves the western S3 origin.
Operations SNS subscriptions are regional and require a new email confirmation.
IAM admin invoke permissions must refer to the new region and API ARN.

`scripts/migrate-sticky-board.py` transfers an already-deployed board into an
empty destination. It freezes source posting, disables the source API Lambda,
backs up all board records and images outside the repository, copies data,
rewrites embedded CDN URLs, and verifies table fingerprints and image bytes.
Identity hashes, monthly claims, note versions and mutation receipts are retained;
connections and one-time WebSocket tickets are not transferred. Clients reconnect
using the new endpoint configuration. The source stays disabled after transfer.

Run migration only during a maintenance window and provide a private
`--backup-directory`. The script writes ordinary local backup files; protect or
encrypt those files after verification. During the Oregon migration, the backup
was separately encrypted and round-trip verified with Windows DPAPI, scoped to
the current Windows account, and its plaintext copies were removed.
Do not delete the old stack or retained resources until destination API,
ownership, image delivery and real-time updates pass live checks. Publish
`assets/js/sticky-board-config.js` with the updated frontend endpoints.

## Contract

All ordinary HTTP routes except device creation require
`Authorization: Bearer <opaque credential>`. Persist the returned
`{credential,deviceId}` in browser storage; do not send a client-supplied
deviceId to establish ownership. Device credentials are random 256-bit tokens;
only their SHA-256 hashes are stored. There is no credential recovery without
that browser storage: clearing it creates another identity, not account recovery.
Public note `deviceId` is the caller's identity for their own note, otherwise
`null`; internal owner/key/asset records never appear in snapshots.

| Method and route | Request | Response |
| --- | --- | --- |
| `POST /devices` | `{}` | `{credential,deviceId}` |
| `GET /board?month=current` | optional `revision=<last revision>` | `{month,revision,notes,deviceId,hasPosted,serverNow,resetAt}` |
| `GET /revision?month=current` | none | `{month,revision,serverNow,resetAt}` |
| `POST /notes` | `{month,type,content OR assetId,paper,x,y,rot,requestId}` | `{month,revision,note}` |
| `PATCH /notes/{id}` | `{month,x,y,rot,version,requestId}` | `{month,revision,note}` |
| `POST /notes/{id}/bump` | `{month,version,requestId}` | `{month,revision,note}` |
| `POST /uploads` | `{}` | `{assetId,url,fields,expiresIn,maxBytes}` |
| `POST /uploads/{assetId}/finalize` | `{}` | `{assetId}` |
| `POST /connections/ticket` | `{}` | `{ticket,url,expiresAt}` |

When `GET /board` is unchanged it returns
`{month,revision,unchanged:true,deviceId,hasPosted,serverNow,resetAt}`, omitting `notes`.
`hasPosted` reflects the caller's monthly claim even after an administrator
deletes their note; use it to disable creation and explain that the monthly slot
has already been used.
Month defaults to current server month; historical `YYYY-MM` snapshots can be
read, but ordinary writes to any noncurrent month return `409 month_changed`.
`serverNow` and next Pacific-month `resetAt` are Unix **milliseconds**; ticket
`expiresAt` is Unix seconds. Note `createdAt` is ISO-8601; `bumpedOn` is Pacific
`YYYY-MM-DD`. Daily/monthly correctness depends on server Pacific time, not
DynamoDB TTL deletion or the browser clock.

Notes have `{id,type,content,paper,x,y,rot,z,version,createdAt,bumpedOn,deviceId}`.
Types: `text`, `draw`, `photo` (and `image` alias). Text is 1–256 UTF-16 units
(matching a browser textarea), trimmed. Papers:
`yellow,pink,blue,green,cream,purple,peach`. Image content is an HTTPS
CloudFront URL. To match the existing board renderer, `x,y` are world-pixel
**center** coordinates `[-4000,4000]`; rotation is degrees `[-180,180]`;
all notes are 200×200. Server SAT tests positive-area intersections of rotated
rectangles. Touching edges alone do not count as covered.

Upload the already-cropped image Blob using S3 **multipart form POST**: copy all
returned `fields`, then append `file` last. Do not upload a data-URL string.
Presigned policy restricts the exact staged key, expiry (300 seconds), and byte
length (1–1,048,576 bytes). Finalization verifies byte size, decodes JPEG/PNG/WebP
only with a 16-megapixel cap, applies EXIF orientation, crops/resizes to 480×480,
and writes a freshly created RGB WebP without metadata. Original uploads are
private, never served by CloudFront, and removed after successful finalization.
Finalize is safe to retry; note creation checks asset ownership/readiness/expiry.

Errors are non-2xx with `{error:{code,message},message,requestId}` (top-level
`message` is provided for the existing browser adapter). Version conflicts,
monthly limits, not-covered/daily bump rules and exhausted board limits are
explicit 409s; invalid input is 400; rate/session limits are 429; AWS failures
are 503. Logs contain request IDs/error codes, never credentials, raw IPs,
request bodies or uploaded images.

## Atomicity, retries and broadcasts

One note is allowed per device per Pacific month. The note, permanent monthly
claim, CAS-incremented revision/maxZ/count, request receipt, and durable event
are written in **one DynamoDB transaction**. Moves require caller ownership and
the latest version; moving does not raise z. Bumping requires overlap by a
higher-z note and is allowed once per Pacific day; **posting consumes that day's
bump**. z is server allocated and capped at 1,000,000. Maximum 500 notes × bounded
text keeps paginated consistent snapshots well below API payload limits.

Every note mutation needs a URL-safe 8–100-character `requestId`. Retries must
use the **exact same request body and route**. A durable receipt returns the
original result even after a lost response. Reusing an ID with another payload
is rejected. Receipts last approximately 45 days, not forever. Conditional
contention retries are bounded to five attempts; other AWS transaction errors
are surfaced. Snapshot reads check metadata revision before and after all
strongly consistent note-query pages, with at most four attempts. A compare
with a revision is a valid point-in-time optimization, not a guarantee that the
board cannot change immediately afterward.

Only stream `INSERT` records whose SK starts `EVENT#` reach the broadcaster.
It paginates the month connection GSI in pages of 100, with eight concurrent
sends per page. `GoneException` and expired connections are purged. Every other
send/query/delete failure is logged and returned as a partial batch failure so
Lambda retries the durable stream record; successfully notified clients may
receive duplicate/older invalidations. No note content or ownership is sent:
WebSocket messages contain only `{month,revision}`.

Tickets are hashed, single-use and expire after 60 seconds (explicit checks,
not TTL). Ticket response `url` is the base WebSocket stage URL; append
`?ticket=<URL-encoded ticket>` when connecting. Four active two-hour session
leases per device cap parallel sessions.
`$disconnect` releases a lease; abrupt loss/Gone can hold a slot until expiry.
Send `{"action":"heartbeat"}` approximately every 60 seconds: the server updates
the connection month and sends the current month/revision. Heartbeats do not
extend the two-hour lifetime. Reconnect with a new ticket before two hours.
Fetch a snapshot on connection/reconnection; poll `/revision` every 30 seconds
and at month reset, and fetch when month/revision changes. The eventual GSI,
disconnects, stream retries, connection race, and 24-hour DynamoDB stream
retention mean WebSockets are a latency optimization, not the correctness source.

## Manual administration (IAM only)

The HTTP API admin routes use **AWS_IAM** authorization; opaque device credentials
are not accepted. Existing IAM users/roles must be allowed `execute-api:Invoke`
on the output `AdminInvokeResource` ARN. Sign requests with SigV4 for
`execute-api`, region `us-west-2`, using existing temporary credentials:

- `PUT /admin/settings`, JSON `{"postingEnabled":false}` disables create,
  move, bump, upload and finalize; `true` re-enables. The disabled setting is
  checked inside every note transaction, preventing a race with in-flight writes.
  Exact retries of already committed mutations still return their saved receipt.
- `DELETE /admin/notes/{id}?month=YYYY-MM`, JSON
  `{"requestId":"moderation-unique-id"}` deletes the note and atomically emits an
  invalidation. **The monthly identity claim remains**; deletion is moderation,
  not permission to repost. It does not delete the immutable image immediately.

No unauthenticated moderation endpoint, admin browser secret, deployment
credential, or new administrator principal is created.

## Cost, limits and cleanup

HTTP stage throttle is 10 requests/sec with burst20; WebSocket stage is 5/sec
with burst10. Lambda concurrency reservations are **optional and disabled by
default** for low-quota accounts. With sufficient account quota, API10 and
broadcaster2 reservations bound compute parallelism; without reservations the
functions share the account's unreserved pool. Device creation: 5/hour and20/day
per **hashed IP**. Per-device/day
limits: mutation120, upload10, finalize20, bump10, ticket150; shared hashed-IP
ceilings are 10× those values. Tickets additionally12/hour, connections12/hour,
heartbeats150/hour/connection; snapshots90/min/device. `/revision` avoids a rate
counter write and uses API throttling plus credential/meta reads. Failed
requests may consume rate budget; exact committed mutation retries do not.

These limits deter cheap abuse but do not make device identity personhood:
storage resets, multiple IPs and bots can evade monthly identity restrictions.
CAPTCHA is intentionally deferred until keys/provider/policy are configured.
Presigned uploads remain usable until their short expiry even after a kill
switch; publication/finalization is disabled. API Gateway throttles are
best-effort, **not a spend cap**. No WAF, NAT, container build, custom domain,
SNS email or scheduled monthly Lambda is required. Two CloudWatch alarms
(broadcast iterator lag and failure queue depth) have no notification actions
unless `NotificationEmail` is set.

### Optional billing and operational emails

Pass `NotificationEmail=<your-address>` at deployment to create a **$30 monthly,
account-wide AWS cost budget**, with direct email notifications when actual
cost exceeds **$5, $15, and $30**. There are intentionally no service or resource
filters: this budget covers the entire AWS account, **not only this board**.
Credits and refunds are excluded so they do not hide gross charges; taxes,
support, subscriptions, and upfront/recurring charges are included. Billing
data and budget alerts are delayed and can arrive after more spend has accrued.
Alerts do not disable resources, enforce a hard cap, or guarantee a final bill.
Budget alert emails use AWS Budgets' direct email delivery.

The same parameter creates an SNS topic and email subscription for the two
broadcast alarms. **Confirm the SNS subscription using the emailed confirmation
link** before operational alarm messages can arrive; budget emails do not use
this SNS subscription. Optional outputs `OperationsTopicArn` and
`AccountBudgetName` identify these resources. Deployment credentials need
permission to manage AWS Budgets and SNS in addition to the existing stack
permissions. Empty `NotificationEmail` omits the budget, topic, subscription,
and alarm actions. No email address is hardcoded in the template.
On an existing stack, SAM CLI retains the previous parameter value when
`NotificationEmail` is omitted from `--parameter-overrides`; an omitted value
does **not** reset it to the template's empty default. On first creation the
default is empty. Supply a nonempty override to enable/change notifications,
and explicitly pass an empty value when intentionally disabling them (which
removes these conditional resources). A wrapper that only forwards a supplied
nonempty email therefore preserves existing notifications on later updates.

Logs retain seven days. Rate/ticket/session/event TTLs bound control storage.
Published objects expire after approximately40 days, staged after1 day.
**S3 lifecycle and DynamoDB TTL physical deletion are asynchronous**, often
delayed; no monthly cleanup cron is necessary for correctness. S3 lifecycle uses
object age, not calendar rollover. CloudFront can retain a cached published
image until its cache TTL after S3 expiry; images are public CDN assets and
moderation does not revoke already downloaded content. Historical note/claim
rows are retained (images eventually expire); account owner may archive/purge
old board partitions manually. BoardTable and ImagesBucket are retained on stack
deletion to avoid accidental data loss and need explicit owner cleanup to stop
their storage cost.

DynamoDB streams retain24 hours. Retryable broadcast failures retry while records
remain; an SQS failure destination retains failed batch metadata for14 days.
Inspect/replay notifications via a fresh snapshot/revision, not a claim of
indefinite stream replay. At large audience sizes broadcast fanout and cached
image egress dominate costs; enforce operational traffic limits before scale.
