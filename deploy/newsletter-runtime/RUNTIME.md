# Dedicated non-sending staging runtime

ISLA modifications to Plunk, AGPL-3.0. This entry point is NOT upstream Plunk.
It imports only the dedicated draft app/editor/storage/session boundary. No
ledger, upstream app, queue, SMTP, SES/Resend client, worker, import, signup or
webhook module is included in the artifact. All sending remains unavailable.

## Deliberately locked release

This release accepts only `auth: "locked"`. The editor code is packaged but all
staff pages/assets/APIs remain default-off (404), even with a signed cookie.
No fixture credentials, staff table, minting endpoint or production secret is
installed. Healthy means the dedicated staging database is reachable under a
non-superuser/non-bypass-RLS role without ledger writes; it does NOT mean a
live accepted staff platform. `/health/live`, `/health/ready` and `/source` are
loopback-only operational endpoints. Readiness explicitly reports
`staffAccess: false`, `sending: false`, `customerDispatch: false`.

Live activation needs a separately commissioned server-side website-session
binding, least-privilege read access to the canonical active staff id/role table,
real session compatibility/revocation tests without impersonation, and scoped
HTTPS ingress. Do not inject the website's general-purpose privileged DB
credential or a service-role key as a workaround. There is no switch in this
release that silently enables production auth.

## Build exact corresponding source

From a clean `isla/resend-staff` checkout with repository dependencies installed:

    corepack yarn tsc -p tsconfig.isla.json
    corepack yarn tsc -p tsconfig.isla.tests.json
    corepack yarn tsc -p tsconfig.isla.build.json
    corepack yarn vitest run --config vitest.isla.config.ts
    node deploy/newsletter-runtime/build.mjs /absolute/new/private/artifact-directory

Run the scoped ESLint binary from apps/api as documented in EDITOR.md; repeat
its real Chromium harness. The builder refuses dirty/wrong-branch source,
compiles TypeScript and copies only six explicit application modules, notices,
schema/grants and pinned minimal npm dependencies. `npm ci --ignore-scripts`
installs from the dedicated integrity-locked dependency tree, not the monorepo.
It emits `release.json` with the exact Git SHA and immutable corresponding-source
URL, and `manifest.json` with SHA-256 file hashes. Hash the final tar archive
and compare after transfer. No operational evidence or runtime data belongs in
this public source directory. Build the provided pinned-base Dockerfile using
this small artifact as context; no production monorepo build or package install.

## Private configuration (no new environment variables)

Pass exactly one absolute JSON configuration filename to NewsletterServer.js.
Config and DB file must be regular files with no group/other access (0600/0400),
readable by runtime UID 1000. Use a read-only private mount, never bake secrets
into image layers. Configuration keys, all explicit:

- `auth`: only `locked`.
- `websiteOrigin`: an exact HTTPS origin (no path/userinfo/query/fragment).
- `host`: defaults to `127.0.0.1`; `0.0.0.0` permitted ONLY inside an isolated
  container whose host publication is explicitly bound to 127.0.0.1.
- `port`: unused unprivileged port chosen after target inspection.
- `databaseFile`: absolute path to another private JSON file with `host`, `port`,
  `database`, `user`, `password`. Host is restricted to local Unix socket,
  loopback, or the isolated `newsletter-db` Docker alias. Remote database URLs
  and TLS overrides are unsupported. Do not use transaction-pool endpoints.

The optional future NewsletterLedger uses session advisory locks across commits;
a dedicated direct connection or verified session pool is required. PgBouncer
transaction pooling cannot preserve those locks. This locked entry point does
not import NewsletterLedger or issue dispatch claims.

Initialize schema.sql manually only in a NEW dedicated newsletter DB, not at app
startup. Create a private non-superuser `newsletter_runtime` login server-side;
apply grants.sql once after schema.sql. The scoped role can select/insert/update
drafts and select/insert revisions under RLS, not create schema, delete history,
read contacts or write deliveries. The revision trigger runs with invoker rights.
Never run these grants against the website database. No production canonical
schema or staff role write is required by this release.

## Supervision and containment

Use an isolated INTERNAL Docker network, no DB host publication, loopback-only
app publication, no provider credentials or unrelated mounts. Run as UID 1000,
read-only root, cap-drop ALL, no-new-privileges, tmpfs /tmp, memory/CPU/PID caps
and json-file log size/rotation limits. Pin DB and app images by digest/image ID;
retain the exact artifact and previous compatible image. The application pool
is bounded to three connections with connect/query/statement timeouts. HTTP
request/header timeouts and a bounded graceful SIGTERM shutdown are configured.
The Docker health check tests real DB readiness, not just an open socket. Docker
restart policy handles exits, NOT an unhealthy-but-running process: monitor
health separately; no unattended scheduler is installed by these scripts.

The Dockerfile pins Node's multi-platform digest; record actual image/platform
and Node/PostgreSQL versions privately at deployment. Database image selection,
network creation and credentials are operator-owned. No deploy script here may
restart shared website/nginx/forum/gateway services. No public ingress is
configured by this artifact. A hostname or nginx change is a separate gate.

## Backup and rollback

Before changes, privately preserve scoped state/config references and write a
rollback runbook. For this dedicated DB, take a consistent pg_dump custom archive,
mode 0600, plus artifact/manifest and private configuration references. Test
pg_restore only into a separate dedicated restore DB, sending disabled. Compare
all table snapshots/constraints and prove application readiness with the scoped
role. Never restore old ledger/suppression state over live data. Stop/drop only
the isolated restore fixture, not the retained dedicated database.

Exercise rollback by stopping ONLY the new staging app, verify its port closes,
then recreate ONLY that app using its retained exact image/config and verify
readiness/source/routes and unchanged data. On initial install no predecessor
app exists: this proves fail-closed removal and exact-image reactivation, NOT
cross-version/schema rollback compatibility. Keep the DB and new state intact.

Local pg_dump/restore evidence is not encrypted off-host disaster recovery.
Off-host destination, encryption/key ownership, retention, monitoring and a
separate disaster-recovery restore remain acceptance requirements. No customer
imports, provider calls or real sends are needed for this non-sending phase.
