# Image Converter — serverless backend

Gated image conversion tool for ryaneng.land. Entirely serverless (API
Gateway HTTP API + Lambda + DynamoDB + S3 + SES) — nothing runs, and nothing
is billed, when nobody is using it. Realistic monthly cost at low volume:
**$0–$1** (all four services have an always-free tier at this scale; the one
thing that isn't literally $0 is the handful of cents per GB-second the
container Lambda uses while actively converting a file).

## Architecture

```
Browser (tools/image-converter on ryaneng.land)
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
- A [Google reCAPTCHA v2 ("I'm not a robot" checkbox)](https://www.google.com/recaptcha/admin/create) site/secret key pair for `ryaneng.land`.
- An SES-verified sender identity (domain or single address) and a verified
  recipient address if your SES account is still in sandbox mode. To send
  from/to arbitrary addresses, request SES production access first.
- If using the custom domain `api.ryaneng.land`: an ACM certificate for that
  name in the same region you deploy to, validated via DNS.

## Deploy

```powershell
cd services/image-converter
sam build
sam deploy --guided
```

When prompted, supply:

- `SiteOrigin` — `https://ryaneng.land`
- `ApiDomainName` — `api.ryaneng.land` (or leave blank to skip the custom domain and use the default `*.execute-api.*.amazonaws.com` URL)
- `AcmCertificateArn` — required if you set a custom domain
- `HostedZoneId` — only if `ryaneng.land`'s DNS is in Route53; otherwise leave blank and add the CNAME/A-alias manually using the value `sam deploy` prints out
- `SesFromAddress`, `SesToAddress`
- `RecaptchaSiteKey` — the public site key (the secret key is set separately, below)

If your DNS is **not** in Route53 (e.g. Namecheap/Cloudflare, which is common
alongside a GitHub Pages `CNAME` file like this repo has), leave
`HostedZoneId` blank and manually create the DNS record API Gateway's console
shows you for the custom domain, plus SES's DKIM CNAME records for domain
verification.

### After the first deploy: set the real secrets

The template seeds two SSM parameters with placeholder values so the stack
deploys cleanly; overwrite them for real immediately after:

```powershell
aws ssm put-parameter --name image-converter-token-secret --type SecureString --overwrite --value "$(python -c 'import secrets;print(secrets.token_urlsafe(32))')"
aws ssm put-parameter --name image-converter-recaptcha-secret --type SecureString --overwrite --value "<your reCAPTCHA secret key>"
```

### Issue an access code

```powershell
cd scripts
python generate_access_code.py --table <AccessCodesTableName from stack output> --max-uses 20 --expires-days 30 --label "jane@example.com"
```

This prints the raw code once — send it to the requester yourself (e.g. by
replying to their request-access email). Nothing else needs to run; there is
no automated code delivery.

## Frontend wiring

After deploy, edit [tools/image-converter/app.js](../../tools/image-converter/app.js) and set:

```js
const API_BASE_URL = "https://api.ryaneng.land"; // or the default execute-api URL
const RECAPTCHA_SITE_KEY = "<your reCAPTCHA site key>";
```

Also replace both `RECAPTCHA_SITE_KEY_PLACEHOLDER` occurrences in
[tools/image-converter/index.html](../../tools/image-converter/index.html)
(`data-sitekey` attributes) — Google's widget reads the key straight from the
HTML, not from JS.
