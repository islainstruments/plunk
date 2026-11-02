# Draft-only staff newsletter API

ISLA modifications to Plunk, AGPL-3.0. Corresponding source:
https://github.com/islainstruments/plunk/tree/isla/resend-staff
Preserve LICENSE and these build instructions. Responses link to source; the
dedicated staff editor displays a prominent corresponding-source link. A future
production release must also display its deployed revision. See [editor](EDITOR.md).

## Implemented boundary

`createNewsletterDraftApp` is a separate Express application factory, with no
import of upstream `app.ts`, queue workers, SES, SMTP, signup/login controllers,
NewsletterLedger or provider transport. It uses the existing `websiteStaffLookup`
for fresh signed-session and active-role checks. No Plunk token or API key works
as staff authorization. `enabled` must be exactly boolean `true`; otherwise all
draft routes are absent. This is a constructor option, not a new environment
variable. No server starts merely by importing the module.

Dependencies: installed Express 5, pg, zod, sanitize-html and Node crypto. Two
server-owned PostgreSQL pools are injected: staff lookup and newsletter storage.
They share the isolated fixture DB in tests only. Production roles, RLS policies,
connection timeouts, pool limits and staff-table compatibility require commissioning.
Schema application is always explicit, never part of app startup or readiness.
The newsletter schema revokes public access and enables RLS without granting
browser or anonymous policies. A production server role must be provisioned with
reviewed policies/grants; fixture tests run as their isolated database owner.

No sender/recipient is required to edit. No sender, recipient, campaign state,
provider key or dispatch flag is accepted in a draft payload. Strict validation
rejects extra fields. Draft changes only affect drafts and draft_revisions.
A database trigger saves each successful revision in the same statement/transaction.
No update/delete history endpoint exists. Production grants must disallow history
UPDATE/DELETE; insert permission/policy is needed by the invoker-security trigger.
Database owners can alter data and must not be used as production application users.

## HTTP contract

All staff paths are relative to the existing website origin, not a new hostname.
No live ingress is installed. A dedicated authenticated browser editor is now
implemented and browser-tested locally; this is not a production deployment.

- GET /health/live: unauthenticated, process liveness only, `sending:false`.
- GET /staff/newsletters: active staff, dedicated HTML editor. Its editor.js and
  editor.css assets use the same staff boundary. The document uses self-only
  scripts/styles/connections/frames, no inline script or untrusted HTML injection.
- GET /staff/newsletters/api/ready: active staff only; confirms draft/history
  tables are queryable plus fresh staff lookup; no provider/delivery readiness claim.
- POST /staff/newsletters/api/drafts: admin, exact configured Origin required.
  JSON fields: subject (1..300 characters, no CR/LF), html (1..200000 characters),
  text (1..100000 characters, nonblank). Returns 201, Location, id, revision=1,
  and saved content. HTML and independently written plain text are retained.
- GET /staff/newsletters/api/drafts: active staff; at most 20 summaries with
  id/revision/subject, not full content. `next` is a UUID cursor or null.
  Continue using `?after=<next>`; pagination is lexicographic UUID, not time order.
- GET /staff/newsletters/api/drafts/:id: active staff; full saved draft or 404.
- PUT /staff/newsletters/api/drafts/:id: admin plus exact Origin. JSON fields
  revision (expected current integer), content (same strict draft fields).
  Atomic compare-and-swap returns the next revision. A stale/concurrent edit
  returns 409; reload and reconcile, never overwrite silently. Missing ID is 404.
- GET /staff/newsletters/api/drafts/:id/preview: active staff; sanitized inert
  HTML. Optional `?revision=N` pins the preview to a saved audited revision;
  unknown revision is 404, invalid revision is 400. The editor pins its HTML
  iframe to match the independently fetched saved text. `?format=text` serves
  original plain text as text/plain. Remote image
  URLs and alt text remain in saved content/preview markup, but sandbox/default-src
  CSP blocks image/tracking requests, scripts, navigation and forms. This is not
  an email-client visual rendering or uploaded-asset acceptance test.

Anonymous/expired/inactive/tampered/duplicate staff cookies are denied (401).
Active viewer/support_agent/developer may read/preview, never write (403).
Admin writes with missing/foreign Origin are denied (403). No CORS allowance
or alternate auth route is installed. JSON body limit is 1 MB; invalid requests
return 400, oversized input 413, DB failure 503 without internal details.
All responses are private/no-store, no-referrer and nosniff. API reads return
untrusted original draft HTML as JSON; an editor must not inject that JSON HTML
into its own DOM. Use the sandboxed preview route, not unsandboxed innerHTML.

All send/import/webhook/auth endpoints return 404 in this composition, including
/v1/send. The older standalone NewsletterRouter is not mounted. Its separate
ledger tests still use injected mock responses and signed synthetic webhook facts.
None of those tests constitute live provider sends or human opens.

## Build and verify

From repository root, after `corepack yarn install --immutable` and fixture DB
readiness (see README):

    corepack yarn tsc -p tsconfig.isla.json
    corepack yarn tsc -p tsconfig.isla.tests.json
    corepack yarn tsc -p tsconfig.isla.build.json
    corepack yarn vitest run --config vitest.isla.config.ts

From apps/api:

    ../../node_modules/.bin/eslint src/isla

Compiled module: apps/api/dist/isla/NewsletterDraftApp.js, importing only local
isla modules and installed API dependencies. The module exports the factory,
not a supervised daemon or deployment recipe. Build output is ignored by git.
Tests exercise real HTTP handlers with real isolated PostgreSQL. The suite also
covers role revocation, exact-Origin checks, malicious previews, body limits,
keyset pagination, concurrent saves and zero delivery/contact/campaign rows after
normal draft editing. The existing ledger suite continues to cover its separate
immutable-request, locking, 23-hour retry quarantine and sticky-suppression contract.

## Backup/restore and rollback

The isolated test uses PostgreSQL 17 pg_dump custom format for isla_newsletter,
restores into a new random fixture database and compares exact JSON snapshots
of every newsletter table, including draft history, contacts, frozen accepted
mock delivery, suppression, provider facts and throttle state. It checks the
immutable-delivery trigger, reapplies the additive schema and verifies restored
dispatch is disabled. It deletes its own generated database/archive in finally.
It never reads DATABASE_URL or restores over the source DB. Addresses are synthetic
.invalid contacts; acceptance is generated solely by the injected mock transport.

This proves logical fixture recovery, NOT production off-host backup retention,
encryption, storage capacity, RTO/RPO or image rollback. Those are deployment gates.
For a future release, retain previous pinned image/config and capture a consistent
private backup before the additive migration. Verify in an isolated target with
all sends disabled. Back up all newsletter tables plus separately commissioned
asset/config references; never publish dumps or runtime secrets in this fork.

Minimal rollback for this slice: remove its ingress or set constructor enabled=false,
then select the retained compatible application image. Leave additive tables/data
intact; do not drop new tables or replay drafts as sends. Because this composition
never queues work, disabling it has no worker-drain requirement. If ledger delivery
is later integrated, pause only that newsletter worker and reconcile unknown
attempts first. Never overwrite a current delivery/suppression ledger with an old
backup and resume sending. An older application must not erase newer opt-outs,
accepted IDs or revision history. No production image rollback was performed here.

## Upstream editor decision and remaining gates

The upstream web app cannot safely be served unchanged below /staff/newsletters.
Observed next.config.js has no basePath; _app.tsx redirects to root /auth/login
and /projects/create, uses its own user/project guards and mounts project-wide
providers. lib/network.ts prefixes API_URI and attaches X-Project-Id. _document.tsx
has root-relative assets. A reverse-proxy prefix alone does not fix these assumptions
or authorize administrative APIs. Upstream API startup imports SES and queues;
the unified worker starts email/campaign/domain processors. Neither is started
or modified for this non-sending slice.

A dedicated same-origin staff editor is implemented in NewsletterEditor.ts,
served by this isolated Express composition at /staff/newsletters without
another hostname. It uses the draft API, not upstream Plunk project providers,
contacts, uploads or auth. It has been exercised against emitted JavaScript in
real Chromium, including conflicts, roles and independent text. No Next code
was changed. This is a working local editor, not a static stub or deployed app.
See EDITOR.md for workflow, reproducible browser tests and precise limitations.

Still required: authoritative live website session compatibility and least-privilege
DB integration; production schema
review, scoped supervision, HTTPS routing and source-revision display; backup
retention/off-host recovery and image rollback; canonical eligibility/suppression
sync; account-wide provider throttling and signed-webhook commissioning; approved
sender/reply-to and explicitly designated staff recipients before any real send.
Customer imports and dispatch remain closed. Existing transactional email and
product/account/order access have not been touched.
