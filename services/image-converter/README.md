# Image Converter — serverless backend

Gated image conversion and optimization using API Gateway, Lambda, DynamoDB,
S3, and SES. Both tools share the access gate, quotas, buckets, and worker.
The optimizer outputs WebP at quality 80, strips metadata, applies EXIF
orientation, and scales the longest edge to exactly 1080px without cropping.
Smaller inputs are upscaled. Animated or multi-page inputs use their first frame.
Costs depend on usage, storage, registry images, DNS, and account free-tier eligibility;
zero cost is not guaranteed.

## Architecture

```
Browser (image-converter or image-optimizer)
   │
   │ 1. solve reCAPTCHA + enter access code
   ▼
POST /verify ─────────────► verify_access Lambda ─► DynamoDB AccessCodes
   │  (returns short-lived signed session token, no DB session needed)
   │
   │ 2. POST /uploads (Bearer token) ─► get_upload_url Lambda ─► presigned S3 PUT URL
   │ 3. browser PUTs file straight to S3 (never touches a Lambda)
   │ 4. POST /convert (Bearer token) ─► submit_job Lambda ─► DynamoDB Jobs (PENDING)
   │        └─ async invoke ─► convert_worker (container Lambda: ImageMagick +
   │                           Ghostscript + librsvg + dcraw + libheif)
   │ 5. poll GET /jobs/{id} ─► job_status Lambda ─► presigned S3 GET URL when DONE
   ▼
Separately: POST /request-access ─► request_access Lambda ─► SES email to owner
            (owner manually runs scripts/generate_access_code.py and emails
             the code back — no automated code issuance, so there's nothing
             to automate an abuse loop out of)
```

## Why it's designed this way

- **No servers, no idle cost.** Every piece is pay-per-invocation.
- **Low-tech but abuse-resistant access codes.** Codes are never stored in
  plaintext (only a SHA-256 hash), have an owner-chosen max-use count and
  expiry, and verifying one is rate-limited per IP. Issuing a code is a
  manual, human-reviewed step (you read the request-access email and decide),
  which is the actual abuse control — nothing automated can mint its own
  codes.
- **Stateless sessions.** A verified code mints an HMAC-signed token
  (`common/security.py`) instead of a server-side session table — one less
  moving part, one less thing to pay for or clean up.
- **Direct-to-S3 uploads.** The browser PUTs straight to S3 via a presigned
  URL, so file bytes never pass through (and never count against) an API
  Gateway/Lambda payload limit.
- **Async conversion with polling.** Some formats (RAW, PSD, PDF at high DPI)
  can take longer than API Gateway's 29s hard timeout, so conversion runs in
  a separate, longer-timeout container Lambda invoked asynchronously; the
  frontend polls `/jobs/{id}`.
- **Hardened ImageMagick policy.** `convert_worker/policy.xml` disables every
  coder/delegate this service doesn't need (MSL, MVG, URL/HTTPS, etc. — the
  classic "ImageTragick" attack surface) and caps memory/disk/pixel
  dimensions/time so a hostile upload can't be used as a DoS vector.

## Known limitations (by design, see chat history)

- `.ind` / `.indd` / `.indt` (Adobe InDesign) are **not supported** — no
  open-source tool can read this proprietary format.
- RAW formats (`raw`, `arw`, `cr2`, `nrw`, `k25`) are **source-only**. There's
  no such thing as authoring a real camera-RAW file from a rendered image, so
  they were removed from the "convert to" list.
- `.ai` files convert correctly only if they were saved with "PDF
  Compatibility" enabled (the Illustrator default) — Ghostscript reads the
  embedded PDF stream.
- HEIC/HEIF encode/decode goes through `heif-convert`/`heif-enc` from
  `libheif-examples`. Verify this works after your first deploy — the
  IM6 package build's bundled HEIC delegate is not always reliable.
- Multi-page PDFs: only page 1 is rasterized.

## Prerequisites

- AWS account, [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), Docker (for the container-image Lambda build).
- A [Google reCAPTCHA v2 ("I'm not a robot" checkbox)](https://www.google.com/recaptcha/admin/create) key pair for your site domain.
- An SES-verified sender identity (domain or single address) and a verified
  recipient address if your SES account is still in sandbox mode. To send
  from/to arbitrary addresses, request SES production access first.
- An ACM certificate for your API domain in the deployment region, validated
  via DNS, and a Route53 hosted zone for that domain.

## Deploy

Copy the root `.env.example` to `.env` and fill in your deployment values.
The local `.env`, SAM config, build artifacts, and generated browser config are
ignored by Git. AWS credentials stay in your AWS CLI login, not in the repository.

```powershell
./scripts/deploy-image-tools.ps1
```

Docker Desktop must be running. Deployment stops if the build fails.
Secret values belong in SSM SecureString parameters, never in browser config.

### After the first deploy: set the real secrets

The template creates placeholder parameters on first deploy. Set real values in
SSM SecureString for `image-converter-token-secret`, `image-converter-recaptcha-secret`,
and (only for local testing) `image-converter-dev-bypass-secret`. Never use the
placeholder values. Subsequent deployments should not overwrite real secrets.

### Issue an access code

```powershell
cd scripts
python generate_access_code.py --table <AccessCodesTableName from stack output> --max-uses 20 --expires-days 30 --label "jane@example.com"
```

This prints the raw code once — send it to the requester yourself (e.g. by
replying to their request-access email). Nothing else needs to run; there is
no automated code delivery.

## Frontend wiring

From the repository root:
```powershell
./scripts/build-tools.ps1
```

This generates ignored `tools/image-config.js` containing ONLY `IMAGE_TOOLS_API_URL`
and `RECAPTCHA_SITE_KEY`. Those values are necessarily visible to visitors; they
are not credentials. No signing secrets, reCAPTCHA secret, bypass secret, AWS
account IDs, or email addresses are included.

For GitHub Pages, select **GitHub Actions** as the publishing source and set
repository Actions variables `IMAGE_TOOLS_API_URL` and `RECAPTCHA_SITE_KEY`.
The Pages workflow generates an allowlisted public artifact, excluding `.env`,
backend source, and deployment artifacts. Do not publish the repository root
from a general-purpose web server that could serve `.env`.

Removing a value from current source does not remove earlier Git history.
Rotate any actual credential exposed in commits, logs, or chat. History rewriting
requires a coordinated, separate operation; this change does not force-push.
