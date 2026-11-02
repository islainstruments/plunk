# ISLA native newsletter backend extension — 2026-11-02

AGPL-3.0; preserve upstream LICENSE and existing notices. Base company source:
86949e2bb6c2d034232d1b2d0283ba55cafe178f. This extension is source/test evidence,
NOT a deployed release, transport commissioning, customer-import acceptance or legal signoff.

## Unchanged security and release boundaries

Native website staff session/active role and exact-Origin browser-write checks remain
in force, as does the project-fixed native secret-key automation boundary. No keys
are returned to browsers. Every administrative extension goes through that same
allowlist. No alternate auth, SES workers, SMTP, scheduler, domain mutation,
transactional website path or general provider egress is added. Native server
constructs the ledger with mode=disabled. Native customer upserts remain .invalid-only;
no real sender or test recipient is configured by this work.

## Additive read APIs (base /staff/newsletters/api)

GET /contacts/:id/marketing-status:
  {version:1, nativeSubscribed:boolean, review:boolean,
   localVetoes:string[], consentEvidencePresent:boolean,
   canonical:{state:'not_suppressed'|'suppressed'|'unavailable',
              reason:'canonical-marketing-veto'|null, checkedAt:ISO8601|null},
   eligible:boolean|null}

Project-bound; missing contact404, missing/invalid auth401, wrong project403.
Canonical reads are fresh per request; exceptions produce state=unavailable with
checkedAt=null, never a cached positive. eligible=null means no known local veto
but canonical unavailable; any known veto gives false even during outage.
Canonical reason is a generic policy veto, NOT a fabricated detailed Supabase
reason. Positive eligibility is not consent, migration approval or dispatch permission.
Native subscribed alone is never canonical truth. Dependency details/secrets omitted.

GET /campaigns/:id/delivery retains existing intended,queued,accepted,skipped,review,
unsubscribed,providerEvents,denominators,caveat,trackingCapability,scope,staffTests.
Adds manifest:null|{frozen_at:ISO8601,selected:number,excluded:number,remaining:number}.
Absent manifest means no frozen audience. intended still means prepared-to-date,
NOT all selected audience members. selected includes exclusions; selected-excluded
is the initial eligible preparation population; remaining counts eligible manifest
rows beyond the durable preparation cursor, NOT outstanding provider deliveries.
queued means prepared deliveries whose current status is queued (not cumulative).
accepted is provider API acceptance, not sent or delivered. email.sent is separately
reported only when a signed provider event exists. providerEvents.total_events counts
distinct svix event IDs; unique_messages counts distinct correlated deliveries,
not people. Unsubscribe is distinct delivery recipients attributed by capability.
Delivery denominator is accepted messages; engagement denominator is observed
delivered messages; zero denominators must show unavailable rates. Staff tests use
a separate ledger identity and denominator. Tracking remains not commissioned;
events cannot establish human engagement or enable tracking settings.

Content APIs unchanged: GET/PUT /campaigns/:id/content with plainText/revision,
optimistic conflict409, independent reviewed text. No native HTTP dispatch, state,
preparation, pause or resume routes are released. Existing boundary returns423 for
send/test/schedule and bypass routes. UI controls must remain held.

## Internal queue and frozen audience semantics

NativeNewsletterDelivery.prepareCampaignPage resolves ALL/FILTERED/SEGMENT with
native CampaignService.buildRecipientWhereAsync; NativeAudience atomically snapshots
membership, personalization and selected exclusion policy in repeatable-read SQL.
Pages use bounded100-contact reads, a60-second transaction deadline and no partial
manifest commit on failure. Large manifests may time out; retry while held rather
than weakening isolation. Snapshot IDs are not a consent source. Explicit
priorAnnouncementIds default to this native campaign ID; before release operators
must supply the reviewed prior-announcement/history identifiers, not infer that the
default captures Gmail/Resend campaign history.

Any prior-send state for a listed announcement (including uncertain), missing
ledger evidence, sticky review, missing consent or local suppression excludes that
member. Canonical/native suppression is rechecked at the transport boundary,
never inferred from freeze time. Later additions/edits cannot change frozen
membership/personalization; content or exclusion-policy revisions are rejected.
A durable cursor advances only after all page enqueues persist. Crash/replay uses
the existing immutable campaign/version/recipient request/key/token, never a new
key. Do not supply the old caller cursor; resume from persisted state. No worker
is installed by this adapter. Internal staff-test pause/resume/attempt are already
serialized with campaign/recipient operations and survive a new process/pool.

The shared newsletter limiter now honors429 Retry-After across deliveries/restarts;
it is NOT reserved Resend team quota or transactional headroom. Canonical/native
eligibility rechecked after limiter reservation. Local opt-out and send operations
serialize by recipient. A remote veto committed after the final canonical query
cannot recall an already-in-flight HTTP request; no distributed exactly-once or
zero-time consent-race guarantee is claimed.

Unknown HTTP acceptance retries only the identical payload/key within23hours;
after that, review/reconcile with provider facts, never rekey or resend audience.
Resend's24hour key lifetime is not indefinite deduplication. Interrupted acceptance
with no provider ID cannot be safely attributed from body email or campaign tags;
manual/provider reconciliation may be necessary. Do not fabricate an email-ID join.

## Events, suppression and preferences

Svix verifies original raw bytes before storage. Supported events: sent, delivered,
delivery_delayed, bounced, complained, opened, clicked, failed, suppressed.
Unknown provider IDs cannot suppress unrelated/transactional contacts. Event-ID
conflicts reconcile the ORIGINAL persisted provider identity, never a conflicting
replay body. Early events reconcile when provider acceptance is saved. Periodic
bounded reconcileProviderEvents repairs persistence/side-effect crashes without
waiting for a provider replay; it runs before canonical outbox export every15seconds.

Explicit bounce.type=Permanent => hard_bounce; Temporary, missing or unknown =>
sticky quarantine/review, NOT hard_bounce and NOT automatic resubscription.
complained => complaint; provider suppressed => quarantine. failed/delivery_delayed
are metrics only, not invented hard-bounce facts. Later delivered/opened events
cannot clear vetoes. Canonical outbox remains local-first, idempotent remote commit
then local acknowledgement, fail-closed on lookup failure. Essential accounts,
password-reset, orders, licences and ReBorn access are untouched. Existing
CanonicalMarketing tests cover remote failure/replay, withdrawals and scoped roles.

Public GET /newsletters/unsubscribe/:opaqueToken is inert confirmation only.
POST requires no login and records durable marketing veto. RFC8058 form
List-Unsubscribe=One-Click returns200 text/plain with no redirect; human confirmation
returns HTML. Unknown well-formed tokens get equivalent success without recipient
disclosure. HTML/plaintext footer and List-Unsubscribe headers share an unguessable
32-byte per-delivery token; no address query parameter. Reject upstream
unsubscribeUrl/subscribeUrl/manageUrl Liquid variables on both preparation paths.
Real received-message/DKIM/mailbox one-click behavior still requires an authorized
staff send; fixtures prove application behavior only.

## Migration and rollout

Apply reviewed apps/api/src/isla/schema.sql explicitly with the deployment's scoped
migration role BEFORE starting this code. It is additive/idempotent: new
isla_newsletter.audience_manifests and audience_members, immutable membership/
definition triggers, RLS and revoked public/anon/authenticated privileges; new
provider_events.bounce_type nullable column. Existing events with unknown bounce
type are conservatively quarantined, never retroactively labeled Permanent.
No public website/account/order schema changes. Existing canonical-marketing.sql
and scoped function grants remain unchanged. Do not auto-run DDL at startup.
Retain a fresh backup and old image; rollback application only, preserving all
newer veto/attempt/provider facts and new tables. Sending stays disabled throughout.

Review source patch against exact base; combine backend files with separately
owned apps/web changes before publishing corresponding source/build and deployment.
Do not copy .fixture-tools, caches, node_modules, DB state or private configuration.
Infrastructure owns provider secret mounts, webhook registration, quota/identity
commissioning and deployment; this extension does none of those. Source offer in
native navigation must name the final combined deployed revision, not this base.

## Reproducible non-sending verification

Node26.7.0, repository dependencies already installed, PostgreSQL17 and local Redis.
All provider HTTP in tests is explicitly mocked; every contact is reserved .invalid.
No production credentials are read. Sequential commands from repository root:

    node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit
    python3 scripts/isla/run-ledger.py
    REDIS_SERVER=/absolute/path/to/redis-server python3 scripts/isla/run-isolated.py

Use own profile TMPDIR under cache/scratch. run-ledger.py creates/stops disposable
PostgreSQL on a Unix socket only, port55439/database isla_newsletter_fixture;
run-isolated.py uses loopback PostgreSQL55473 and Redis56373 and cleans them up.
Never overlap heavy fixtures/frontend builds. Tests cover actual native controllers,
key/role/Origin scope, import preservation, canonical fresh/unavailable projection,
frozen multi-page membership/personalization, uncertain prior-announcement
exclusion, cursor crash replay, immutable payload deduplication, held customers,
private text/HTML/footer, pause/restart, signed replay/order recovery, bounced
classification,429 shared backoff and acceptance-vs-delivery metric definitions.
