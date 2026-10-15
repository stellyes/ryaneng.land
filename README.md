# My website

Including a README.md seems redundant, but I wanted to put something here anyway for repo's sake.

Just go to the website https://ryaneng.land

## Design choices

I'm one guy with a ton of different hobbies. I have no interest in developing/maintaining a full React website. There's a beauty in the simplicity of the OG web stack (HTML/CSS/JS). I want this website to feel like stepping back into 2003, with my own flare. Choke on it, idc.

For the blog. I'm using pagedown (https://github.com/StackExchange/pagedown). Same MD -> HTML converter used by the one and only StackOverflow. RIP.

## Sticky board

The [sticky board](code/sticky-board.html) uses a separate AWS serverless backend.
See [backend setup and operations](services/sticky-board/README.md) for its API,
limits, moderation, and deployment details.

Deploy using `scripts/deploy-sticky-board.ps1` after authenticating the AWS CLI.
The script writes only public endpoints to `assets/js/sticky-board-config.js`.
Publish that configuration together with the frontend using the existing Pages
workflow. Deployment does not publish the GitHub Pages site or commit changes.
The stack defaults to `sticky-board-west` in `us-west-2` and the allowed production origin
`https://ryaneng.land`.

Pass `-NotificationEmail <address>` to enable account-wide monthly cost alerts
at $5, $15, and $30, plus broadcast-health alarm notifications. Confirm the SNS
subscription email to receive health alerts. Budgets are delayed notifications,
not spending caps, and include other AWS services in the account.

The page uses the shared AWS backend exclusively and reports configuration/network errors instead of substituting a private board. Serve it through an allowed HTTP origin; there is no local-file or demo mode.

Owners are anonymous browser identities, not physically identifiable devices.
Keep browser storage to retain ownership of your note. Clearing it or changing
browsers creates a different identity. Server-side ownership, monthly submission
claims, daily bump limits, and optimistic note versions protect normal use;
rate limits reduce but cannot eliminate determined anonymous abuse.

Committed changes are broadcast over WebSockets; dragging is a local preview
until Save. A disconnected visible page falls back to revision checks every ten
seconds. Connected pages reconcile every thirty seconds and after reconnecting.
Images are uploaded separately and served through CloudFront, never sent through
the real-time connection.

For frontend adapter tests, serve the repository locally and open
`tests/sticky-board-store.html`. It uses mock requests and restores any existing
local board identity after the tests.

`tests/smoke-sticky-board.py --api <ApiUrl>` exercises the deployed API, including
idempotency, monthly quotas, version conflicts, anonymous authentication, and IAM
moderation. It creates a temporary note and removes it in a `finally` block.
The test requires AWS credentials with admin invoke permission and the backend's
prepared build dependencies. Device claims are intentionally retained for the
month; repeated smoke runs also consume the normal device-issuance rate limit.
