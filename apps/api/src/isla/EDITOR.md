# Authenticated staff newsletter editor

ISLA modifications to Plunk, AGPL-3.0. Complete corresponding source, license and
build scripts: https://github.com/islainstruments/plunk/tree/isla/resend-staff

## Working local vertical slice, not a production deployment

`createNewsletterDraftApp` now serves an actual dedicated editor at
`/staff/newsletters` on the same origin as its draft API. It does not proxy or
mount the upstream Plunk dashboard, API, auth controllers, contact hooks, asset
uploads, queues or provider transport. The constructor remains default-off;
`enabled: true` is an explicit server-side commissioning choice. Do not run the
upstream application to serve this surface.

The page, JavaScript, CSS, draft API and previews all require the existing signed
website staff cookie and a fresh active staff-table lookup. There is no alternate
login/signup, API-key login or endpoint that issues fixture cookies. Test cookies
are generated only inside the browser harness, using an isolated synthetic key.
Production website session compatibility still requires separate commissioning.

Inspected upstream `EmailEditor.tsx` and `HtmlEditor.tsx`: the rich editor imports
contact/segment/config/template hooks, project-aware network calls and image
upload behavior. Reusing it unchanged would expand this narrow security boundary.
The dedicated implementation instead uses native labeled HTML-source/plain-text
controls, compiled browser JavaScript and the existing draft API. No Next code,
configuration or Next build was changed or required. It is not a WYSIWYG editor.

## Staff workflow

- Active staff can browse bounded draft summaries (20/page), load a saved draft,
  inspect its HTML and independently authored plain text, and refresh its saved
  sandboxed preview. Draft URLs retain only a draft UUID, not auth or recipient data.
- Only an active admin sees New draft, Save draft and Copy to new draft controls.
  Read-only fields are disabled for viewer, support_agent and developer. Backend
  authorization independently denies their POST/PUT requests. UI visibility is
  not the authorization boundary. Admin writes also require exact configured Origin.
- New drafts require subject, HTML and nonblank independent plain text. Saving
  persists through `NewsletterDrafts`, then reloads the library and saved preview.
  HTML and plain text are never converted into each other.
- Copy to new draft reuses the current content, preserves the original and creates
  no recipient/campaign/delivery. It is a reusable-copy workflow, not a separate
  named template library or template save/apply API.
- Each edit uses the loaded revision. A 409 leaves local fields intact and shows
  the latest saved subject/HTML/text as escaped text. The user explicitly chooses
  whether to discard local changes and load the latest; there is no force overwrite
  or automatic merge. Each successful save retains the database revision audit.
- Reload, draft selection and New draft warn before discarding dirty fields.
  Page exit has a browser unsaved-change warning. Validation/HTTP errors preserve
  local fields, allowing correction/retry. No localStorage drafts or crash recovery
  are implemented; copy unsaved work before closing a failed/session-expired page.
- Preview labels its saved revision and the editor's base revision. HTML uses
  `?revision=<saved revision>` so a concurrent save cannot silently change the HTML
  under its independent text preview. Historical preview reads use the existing
  `(draft_id,revision)` primary key; no schema migration was added for this editor.

The parent document never injects draft HTML into its own DOM. Preview HTML is
sanitized server-side and served inside an empty-sandbox iframe with restrictive
CSP. Image source/alt markup is preserved, but external assets, executable HTML,
links and forms are blocked. This prevents tracking/network calls during preview;
it is not final email-client artwork, CSS fidelity, image upload or delivery
acceptance. Original source is preserved separately in storage.

## Actually exercised browser commissioning

Prerequisites: installed repository dependencies, all three TypeScript checks in
[DRAFT-API.md](DRAFT-API.md), built JavaScript, PostgreSQL 17 fixture described in
[README.md](README.md), OpenSSL, and an actual installed Playwright plus Chromium.
Never use a production DATABASE_URL. The harness ignores it and verifies the
fixed local fixture connection before creating a fresh random test database.

If browser tooling is absent, install it outside the repository, for example:

    npm install --prefix "$TMPDIR/newsletter-browser-tools" --no-audit --no-fund playwright

Point `PLAYWRIGHT_MODULE` at that package's `index.mjs`. `CHROMIUM_EXECUTABLE` is
optional if Playwright's matching Chromium is already installed; otherwise provide
an actual compatible cached executable or install the package's browser using
its documented tooling. Do not invent browser results if installation/launch fails.
This run exercised a cached Chromium 153.0.8010.12 explicitly after the newly
installed Playwright default browser revision was found absent.

From the repository root:

    corepack yarn tsc -p tsconfig.isla.json
    corepack yarn tsc -p tsconfig.isla.tests.json
    corepack yarn tsc -p tsconfig.isla.build.json
    corepack yarn vitest run --config vitest.isla.config.ts
    PLAYWRIGHT_MODULE="$TMPDIR/newsletter-browser-tools/node_modules/playwright/index.mjs" \
      CHROMIUM_EXECUTABLE="/path/to/actual/installed/chrome" \
      node apps/api/src/isla/__tests__/editor.browser.mjs

From apps/api:

    ../../node_modules/.bin/eslint src/isla

The browser harness starts only its own ephemeral loopback HTTPS service from
emitted JavaScript, with generated test-only TLS material. It injects isolated
staff identities, not a public login route, and closes the browser/server and
removes its generated database/TLS/screenshot directory in `finally`. The already
running fixture Postgres is not stopped. An intercepted synthetic 503 verifies
local recovery; it is not a production outage or fabricated provider result.

Observed: 12/12 real browser check groups passed, page errors=0, external
requests=0; 56/56 full commissioning tests passed. Browser groups cover auth and
assets; create/reload/exact text; inert image preview; two-tab conflicts and audit;
copy-to-new; all three read-only roles and backend denial; Origin/live revocation;
absent upstream/auth/import/send paths and zero contact/campaign/delivery rows;
list/mobile/source access; validation/503/discard recovery; 24-draft pagination
and hostile-subject escaping; default-off removal. Vitest also exercises pinned
historical previews and isolated exact-snapshot PostgreSQL backup/restore with
restored dispatch disabled. These are local synthetic results, not live website,
provider send, real consent or production backup acceptance.

## Minimal release and rollback boundary

The change is additive application code only; no new schema or package dependency
is needed for the editor. Retain the preceding source/image and all draft/history
data. Test the exact built source before any future release. Reuse the isolated
backup/restore procedure in DRAFT-API.md; do not back up customer/runtime data into
this source tree. Production encryption, retention and off-host recovery remain
unverified. Rollback is `enabled: false` or removing only the future newsletter
ingress and selecting the retained compatible build, without dropping tables or
restoring old ledger/suppression state. No newsletter worker is started here.

Remaining production gates: authoritative website/session and least-privilege
staff/newsletter DB integration, migration/RLS/grant review, HTTPS ingress and
supervision/resource limits, pinned image and displayed deployed source revision,
production off-host backup/recovery and image rollback acceptance. The app factory
is a tested composition, not a supervised production server or a live staff URL.
A named template library, WYSIWYG editing, image uploads and final email-client
rendering are not implemented. Provider consent/suppression synchronization,
account-wide quota/webhook integration and explicitly approved sender/reply-to/
designated test recipients remain separate gates before any real send. Customer
imports, real/test sending and customer dispatch remain unavailable in this app.
