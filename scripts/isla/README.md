# Native Plunk staff build (AGPL-3.0)

This is the actual upstream Plunk web application and controllers, adapted to an existing website staff session boundary. LICENSE and upstream notices apply. The older NewsletterDraftApp/NewsletterEditor prototype is retained for history but is NOT the native runtime or the assigned platform.

## Reproduce the held native runtime

Use Node >=24.22.1 and Corepack Yarn 4.9.1. From the repository root:

    corepack yarn install --immutable
    node node_modules/prisma/build/index.js generate --schema packages/db/prisma/schema.prisma
    node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json
    cd apps/web
    NODE_OPTIONS=--max-old-space-size=768 NEXT_PUBLIC_ISLA_STAFF=true NEXT_PUBLIC_API_URI=/staff/newsletters/api NEXT_PUBLIC_DASHBOARD_URI=/staff/newsletters/plunk NEXT_PUBLIC_LANDING_URI=/ NEXT_PUBLIC_WIKI_URI=https://github.com/islainstruments/plunk node ../../node_modules/next/dist/bin/next build --webpack
    cd ../..
    node scripts/isla/package-api.cjs /absolute/private/build/native-api-bundle

Build sequentially, not concurrently with PostgreSQL/browser fixtures. The Next config uses one build worker and memory optimizations. The traced API bundle's api/ directory overlays /app in the held Node runtime. Copy apps/web/.next/standalone to /app/web, apps/web/.next/static to /app/web/apps/web/.next/static and apps/web/public to /app/web/apps/web/public. Preserve the generated Prisma engine dependencies. Do not package .env, runtime configuration, backups, recipient exports, test databases or preserved .next directories. Build context must be an explicit allowlist, never the checkout root.

Runtime entry: apps/api/dist/isla/NativePlunkServer.js. It spawns the standalone native web server. Persist the dedicated PostgreSQL database and Redis volume. Readiness: /health/ready. The host loads private /run/newsletter configuration; see NewsletterRuntime's strict schemas. Do not put actual connection values in source/build environment or client variables. Schema application and scoped role grants are operator actions, not automatic startup actions. The website staff shell and private TLS ingress are deployment-specific and not distributed with credentials.

## Transport and consent contract

Native UI content/audience are authoritative for drafting. NativeNewsletterDelivery maps Liquid content and explicit reviewed plain text into the immutable NewsletterLedger request; native CampaignService cursor selection handles ALL, FILTERED and static/dynamic SEGMENT audiences. Preparation is bounded to 100 recipients/page. A frozen content/audience-definition digest prevents edits from creating another revision halfway through preparation. Preparation is internal, not an exposed customer queue route; audience membership itself must be frozen/reconciled before any future authorized production release. Customer dispatch is still code-disabled. Staff tests require separately authorized sender, recipient allowlist and monitored reply-to; the live runtime has no provider key or worker. No HTTP action enables sending. SES domain/queue/scheduler/OAuth/SMTP paths are not commissioned by this host.

API: native secret-key authentication, fixed project scope, no Origin/Cookie on programmatic clients. Public keys and alternate auth are refused. Only reserved .invalid addresses are writable during commissioning. Native POST /contacts requires data.isla.provenance (nonempty sourceCategory/sourceSystem/sourceRecordId/observedAt), review boolean, priorSends array and optional consentEvidence. Consent, provenance/history and review are sticky; native unsubscribed, local veto or canonical veto cannot be reset by import. Canonical outage fails closed. Supabase isla_marketing is the shared veto; local veto is immediate, with durable replay-safe exports. No account/order/licence or essential-email mutations occur.

Public unsubscribe GET is confirmation only; opaque-token POST handles human/RFC8058 unsubscribe, no login. Footer appears in both HTML/plain text. Resend webhook raw-body Svix validation precedes event storage; duplicate and out-of-order events reconcile suppression. Receiver returns 503 if no webhook signing secret is securely provisioned. External webhook registration is a separate operation; no real provider configuration is implied by fixture success.

Customer and staff-test analytics are separate. Acceptance != delivery; unique messages != total provider events. Opens/clicks can reflect proxies/scanners; tracking remains uncommissioned and is not enabled by this build.

## Non-sending tests

Run `NODE_OPTIONS=--max-old-space-size=768 python3 scripts/isla/run-isolated.py` from the repo root; PostgreSQL 17, Redis and private TMPDIR are required. Set REDIS_SERVER if not on PATH. For Chromium coverage also provide an installed Playwright module through ISLA_PLAYWRIGHT_MODULE and use `--browser` after the native web build. Both server fixtures exit before returning; no concurrent build is started.

The native campaign delivery panel includes a separately saved reviewed plain-text alternative. GET/PUT /campaigns/:id/content preserves it with optimistic revisions; stale writes return409, and normal campaign HTML saves do not regenerate it. The delivery adapter defaults to that saved text. Customer and staff-test ledger facts remain separated.

scripts/isla/native-*.integration.mjs use compiled native controllers and a real isolated PostgreSQL database on localhost:55473/plunk_native plus Redis localhost:56373. Only synthetic .invalid data and mocked provider HTTP are permitted. Initialize/reset only that disposable public schema with Prisma db push --force-reset; set DATABASE_URL/DIRECT_DATABASE_URL to the fixture, EMAIL_TRANSPORT=held, synthetic JWT_SECRET, REDIS_URL and HTTPS example.invalid API/DASHBOARD/LANDING/WIKI URIs before importing controllers. Run controller, delivery and import scripts sequentially from the repository root. Never point these destructive fixtures at production. Native unit fixtures also run via vitest.isla.config.ts using a private scratch socket/database; provider HTTP is injected/mocked. The published fixtures are not evidence of real delivery.

## Operations / rollback

Retain prior container image, exact private docker run configuration and PostgreSQL dump before each cutover. Stop/disconnect only the native newsletter app, preserve its fixed private IP and TLS allowlist, and start the candidate with the same resource/security limits. Verify readiness, native key readback, anonymous denial, send/import holds, draft preview and source identity; auto-restore prior container on failure. Do not restart unrelated website/transactional mail/gateway services. Preserve all newer suppression/provider/attempt facts on rollback. Restore into a separate database and reconcile vetoes before switching, never overwrite live data with an older dump.

Off-host backup tooling encrypts the dedicated database/config stream to a separate host; recovery-key custody must be separate from the encrypted archives. Backup restores must remain sending-disabled. No customer audience migration or actual send is authorized by publishing this source.
