# Pattern Studio asset infrastructure

Private, encrypted, versioned S3 storage served through CloudFront Origin Access
Control. This stack provisions infrastructure only. It does not upload artwork,
remove repository assets, change the application, create users, or deploy a
service worker. The existing library keeps working unchanged.

## Deploy

Requires AWS CLI v2 and configured AWS credentials (for example an AWS SSO
profile). The deployment identity needs CloudFormation and the S3/CloudFront
resource-management permissions used by this template, including tagging. No
runtime AWS credentials are placed in the browser. SAM and Node.js are not needed.

Run from the repository root in PowerShell:

```powershell
# Calls AWS to validate the template, without creating or updating resources.
.\scripts\deploy-pattern-studio-assets.ps1 -Profile my-profile -ValidateOnly

# Creates the stack, or updates it on subsequent runs. This incurs AWS charges.
.\scripts\deploy-pattern-studio-assets.ps1 -Profile my-profile
```

Omit `-Profile` to use your usual AWS credential chain. Defaults:

| Parameter | Default |
|---|---|
| `Region` | `us-east-1` |
| `StackName` | `pattern-studio-assets` |
| `SiteOrigin` | `https://ryaneng.land` |
| `PriceClass` | `PriceClass_100` |

If Windows blocks local scripts, and your organization's policy permits running
them, a process-only invocation is:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-pattern-studio-assets.ps1 -Profile my-profile -ValidateOnly
```

This does not change the machine's execution policy. Remove `-ValidateOnly` to
deploy when ready.

The script prints the target account, validates the template, waits for
CloudFormation deployment, and prints `BucketName`, `DistributionId`,
`AssetBaseUrl`, and `LatestManifestUrl`. Repeated runs tolerate no-op changes.
CloudFront provisioning can take several minutes.

`PriceClass_100` restricts serving locations to North America and Europe, not
viewer access; worldwide visitors can still connect, potentially with higher
latency. Use `-PriceClass PriceClass_All` for all locations, at regional rates.
Use `-SiteOrigin https://your-site.example` for another website (no trailing slash).
Only one HTTPS origin is configured; localhost and alternate website origins are
not enabled by default.

CloudFront's generated HTTPS hostname and certificate are used initially. A
custom asset domain, DNS records, and an ACM certificate can be added later. This
is pay-as-you-go infrastructure, not a CloudFront flat-rate plan. There are no
Lambda functions, databases, dedicated servers, paid logging destinations, or
budget alerts in this stack. Configure account billing alerts separately; they
are notifications, not a spending cap.

## Contract for the later migration

Use the bucket root as the library namespace:

```text
latest.json
catalogs/<sha256>.json
assets/<sha256>.svg
assets/<sha256>.png
previews/<sha256>.webp
```

- Publish artwork, previews, then the immutable catalog, and **publish
  `latest.json` last**. It should point to the new catalog revision.
- Compute SHA-256 during publication; do not assume an S3 ETag is a content hash.
- Upload hash-addressed objects with `Cache-Control: public, max-age=31536000,
  immutable` and the correct `Content-Type` (`image/svg+xml`, `image/png`,
  `image/webp`, or `application/json`). Never overwrite a hash-addressed URL.
- Upload `latest.json` with `Cache-Control: no-cache` and
  `Content-Type: application/json`. Its dedicated CloudFront behavior also
  disables edge caching and overrides the viewer header to `no-cache`.
- Other objects honor their cache metadata, with a default and minimum TTL of
  zero and a maximum of one year. Query strings do not create cache variants;
  use content-hashed paths, not `?version=...`.
- CloudFront compresses eligible responses, exposes `ETag` and `Last-Modified`
  to the configured site origin, and supports ordinary browser conditional
  GETs. Use browser-managed revalidation with `fetch(..., { cache: 'no-cache' })`
  for the revision check. Cross-origin custom conditional request headers would
  require OPTIONS/preflight support, which this GET/HEAD-only distribution does
  not enable.
- There is no index document or fallback route. Until migration uploads the
  objects, an asset URL can correctly return 403/404. S3-origin error responses
  can still be cached by CloudFront for at least one second.
- The bucket blocks public access. Visitors read through CloudFront; CORS is
  not authorization or copy protection. This library is public to CDN visitors.
  Do not put user projects, credentials, or private images in this bucket.

Hash comparison, persistent device caching, offline/error notices, lazy
thumbnails, the revised catalog schema, and frontend CDN wiring are **migration
work**, not provided by infrastructure deployment. Keep stable logical asset
identifiers and compatibility with older saved projects during that migration.

## Retention and rollback

The bucket is retained on stack deletion or replacement. Versioning is enabled;
no lifecycle deletion is scheduled, so old versions continue to incur storage
charges. Establish a retention policy once project compatibility requirements
are settled. Keep older immutable assets available rather than automatically
deleting anything absent from the newest manifest.

To roll back a library release later, republish `latest.json` pointing at a
previous complete catalog. No artwork invalidation should be needed.

Deleting the stack removes CloudFront and its access policy but leaves the
bucket and contents. Inspect any retained bucket and all versions before
deliberately deleting it. The deployment script never deletes buckets or assets.

## Checks

```powershell
# Local tests mock AWS: no network requests or deployments.
.\tests\pattern-studio-assets-deploy.ps1
```

`-ValidateOnly` performs AWS template validation, not full deployment validation.
After a real deployment and migration, verify CORS, revision revalidation, and
immutable-object cache headers against the output CDN URL.
