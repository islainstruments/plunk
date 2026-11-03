# Import release and ONE staff test — software continuation, 2026-11-02

This is a bounded code handoff, NOT deployed-platform acceptance. Brad's recorded authorization supersedes the historical blanket pause: reconciled customer import, approved ASYX campaign preparation and ONE test to Brad are authorized. Customer campaign/bulk dispatch is NOT authorized. Infrastructure is sole final test dispatcher; Pablo owns refreshed sources/import/template. No mail is sent by building or deploying this source.

## Import-only runtime release

After Infrastructure's fresh backup and API-only deployment, place mode0600 `import-release.json` in the existing private runtime mount containing ONLY `{"customerImports":true}`. Missing file defaults false; malformed/extra fields fail startup. Restart only native newsletter container using existing limits/network. Read `/health/ready` inside its boundary: imports=true, sending=false. Keep the web runtime without any provider sending key and WITHOUT new ledger-write privileges.

Use EXISTING native secret-key POST /contacts, not a competing import endpoint. Real-address provenance accepts ONLY the exact labels: Shopify customers; current Auth accounts; website subscribers; product notify; ReBorn. Every incoming provenance item must match; .invalid fixture provenance is exempt. Evidence shape, sticky consent/review/history, canonical outage fail-closed, explicit unsubscribe semantics and no-workflow behavior remain unchanged. All alternate contact/bulk/import/send/test/schedule paths remain held. Native key still rejects browser Origin/Cookie and is fixed-project scoped.

Pablo must perform exact address/count readback. `subscribed:false` is a permanent marketing opt-out, NOT an ASYX licence/prior-announcement filter. Preserve licence/beta/NFR/prior-send exclusions in the separately reconciled ASYX segment/manifest and provenance/history; reusable contact eligibility is distinct. This patch does not invent refreshed sources/consent or make current licence ownership an automatic global unsubscribe. Existing arbitrary contact data is preserved, but no new licence-filter policy is implicitly installed. Customer-purpose dispatch remains disabled regardless of migration state.

## Isolated Infrastructure operator, never a web endpoint

`apps/api/dist/isla/StaffTestOperator.js` is a separately invoked CLI packaged with the API. It is NEVER imported or invoked by NativePlunkServer. Run it only in a disposable operator container using the same pinned image/private network constraints, NO ports, and a SEPARATE mode0700 private config directory mounted read-only at /run/newsletter. Do not put operator DB/send credentials in the long-lived web runtime directory/mount.

Provision a separate LOGIN `plunk_staff_test_operator` with random protected password (not in source/stdout), no inherited roles. Apply additive schema.sql then staff-test-role.sql ONLY in plunk_native. The latter grants native read and narrowly necessary ledger read/insert/update with RLS; no native contacts mutation, no authorization update/delete. Do NOT give these privileges to plunk_native_runtime. Application/default role and fixed private IP/TLS restrictions stay unchanged. Operator needs verified scoped canonical TLS access using existing canonical-database.json/CA, plus separately protected `staff-test-database.json` matching databaseConfig and user=plunk_staff_test_operator. Use copies/symlinks within the operator-only protected mount; never publish configuration contents.

`staff-test-release.json` is private strict JSON:
- authorization: brad-2026-11-02-one-test
- campaignId: exact native MARKETING DRAFT supplied by Pablo
- version: rendered content SHA256 from inspect (required after inspect)
- deliveryId: UUID from prepare (required for state/attempt/status)
- credentialFile: absolute operator-only JSON path containing ONLY apiKey (scoped sending-only Resend credential)
- providerHistoryCheckedAt / quotaCheckedAt: ISO8601 timestamps within 10 minutes before each attempt
- providerHistoryReference / quotaReference: nonempty private evidence references, NOT credentials.

Actions (inside operator image /app):
  node apps/api/dist/isla/StaffTestOperator.js inspect
  node apps/api/dist/isla/StaffTestOperator.js prepare
  node apps/api/dist/isla/StaffTestOperator.js resume
  node apps/api/dist/isla/StaffTestOperator.js pause
  node apps/api/dist/isla/StaffTestOperator.js attempt
  node apps/api/dist/isla/StaffTestOperator.js status

Start with authorization+campaignId only; inspect renders the native campaign and saved explicit plain text for the existing eligible Brad contact and returns hash only. Sender MUST be ISLA Electronics <noreply@islaelectronics.com>, Reply-To brad@islaelectronics.com. Infrastructure/Pablo review native body/text/imagery before freezing version. Add returned version privately; prepare compares that exact rendered revision before enqueueing, then reserves ONE persistent authorization. Add returned deliveryId. Prepare does not send or resume. Resume/pause change only that bound staff-test campaign. Live web HTTP dispatch remains423. Do NOT auto-create or resubscribe Brad's contact: use the authorized native import with genuine source/consent evidence, preserving any veto; if Brad already has a veto, resolve through a separately audited preference process, never bypass it for a test.

Before first attempt Infrastructure MUST inspect existing Resend send history and ledger for already accepted OR ambiguous attempts (including sends outside this ledger), reconcile if any, and check shared-account quota with transactional reserve. References/timestamps are operator attestations to real checks, not automated provider-history/quota retrieval. Do not fabricate them. Existing Resend key setup authority does not mean copy a broad management key into the web app. Commission a sending-only credential privately. No provider key is loaded by inspect/prepare/state/status. If the private network egress currently blocks api.resend.com, Infrastructure must permit ONLY the disposable operator's necessary HTTPS egress; do not weaken the long-lived web runtime or unrelated services.

Attempt allows only the bound UUID/version/recipient/from/reply-to, and the campaign still must be running. A transaction/advisory lock prevents a second delivery/revision/campaign from claiming this authorization. Binding is DB-immutable; any other previous test attempt requires reconciliation. The ledger rechecks contact/local/canonical eligibility immediately before HTTP; enforces rate <=0.5 requests/sec; persists first_attempt_at/payload/idempotency key BEFORE HTTP; retries SAME key/body within the existing window; unknown acceptance stays uncertain rather than rotating keys. Do not loop the CLI, rotate authorization, delete its binding, or prepare a replacement after uncertainty. Only retry that same delivery after provider/ledger reconciliation. Already accepted calls do not send again.

Status prints delivery/provider IDs and outcome facts, not content/addresses/credentials. Acceptance != delivery. Actual signed webhook delivery and received mailbox text/images/DKIM/footer/one-click validation must be recorded separately. No real provider/mailbox evidence exists from software fixtures. After the single commissioning operation revoke/drop operator LOGIN or disable it, remove operator sending credential/mount, retain immutable ledger/binding and protected release/history evidence. A future user authorization requires explicit engineering/review, not a fresh UUID for this same authorization.

## Backup and rollback

### Exact designated-staff review audit (not a subscription change)

When the designated staff member has genuine consent and NO local/canonical veto,
but native subscribed=false is derived solely from validation_missing plus the
evidenced transient provider_failure_review, Infrastructure may record the existing
explicit one-test authorization in staff_test_review_audit. This is NOT permission
to clear customer review or automatically resubscribe. The immutable audit pins the
existing native contact, campaign, rendered content SHA256, consent SHA256, exact two
review reasons and private investigation reference. Insert it with Infrastructure's
owner connection only; operator/web cannot insert/update/delete it. Apply only the
additive table/trigger and operator SELECT/RLS policy, not a broad privilege grant.

Only the disposable StaffTestOperator supplies the audit verifier. The native web
runtime and all customer paths retain their ordinary gates. Both prepare and attempt
must match this audit; attempt also requires the immutable one-delivery binding.
Missing/drifted consent, wrong native identity/campaign/version, ANY local suppression
(including quarantine), canonical denial/outage all fail closed. All checks are
repeated at the transport boundary. Global subscribed=false/review=true are preserved.
If a real veto exists, this exception cannot authorize the test. Never delete a veto
or change the audit to force success. Keep immutable audits/bindings on rollback.

An operator-only image overlay may carry these CLI changes without restarting the
long-lived native web service or interrupting contact imports. Publish corresponding
source separately and record both image identities; do not claim the web image changed.

Reuse Infrastructure's existing fresh pg_dump/private config/image backup and API-only overlay pipeline; no frontend rebuild is needed. New schema is additive. Preserve immutable staff_test_authorizations and all delivery/attempt/provider/veto facts on rollback; NEVER restore an old dump over newer attempts. Retain old app image/config and the current web build. Missing import-release file or false value closes imports after native app restart; preserve every suppression/contact record. Native app remains sending-disabled; operator must be stopped independently before rollback. After rollback verify native key read, anonymous denial, staff shell, import/send holds and unrelated services unchanged. No destructive rollback rehearsal is claimed by this software continuation.

## Executed software verification

Node v26.7.0, existing pinned repository dependencies and PostgreSQL17. No frontend build, profile credential read, real send, production import or deployment occurred in software tests.
- `node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json` exit0.
- `python3 scripts/isla/run-isolated.py` exit0 after setting REDIS_SERVER and LD_LIBRARY_PATH to room/native-test-tools/unpacked paths. Real disposable PG+Redis; controller, delivery, import and commissioning fixtures pass. Mock provider HTTP ONLY (including real-address-shaped local fixtures). Exact approved-five-category imports, readback, unknown rejection, sticky opt-out/review/history/canonical veto/outage, held alternative routes pass.
- Single-test fixtures prove concurrent same-binding reservation, frozen content/sender/UUID pin, pause/resume, uncertain restart SAME key/body, replacement revision rejected, accepted retry dedup, immutable authorization, customer dispatch held; actual operator-role RLS permits ledger attempt and denies native contact mutation/auth deletion.
- `NODE_OPTIONS=--max-old-space-size=512 python3 scripts/isla/run-ledger.py` exit0, 91 tests/7 files passed. Existing Vite config-loader warning only.
- `node apps/api/dist/isla/StaffTestOperator.js inspect` WITHOUT private release/config exits1 with redacted rejection; no secrets loaded or send. Successful production CLI execution is Infrastructure commissioning, NOT claimed here.

Initial isolated command failed because system redis-server is absent; reused existing room Redis binary/libraries rather than installing globally. First new fixture failed because native project requires explicit public/secret fields; corrected synthetic fixture and reran successfully. These are disclosed failures, not manufactured successes.
