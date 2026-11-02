# Dedicated non-sending staging runtime

ISLA modifications to Plunk, AGPL-3.0. This entry point is NOT upstream Plunk.
It imports only the dedicated draft app/editor/storage/session boundary. No
ledger, upstream app, queue, SMTP, SES/Resend client, worker, import, signup or
webhook module is included in the artifact. All sending remains unavailable.

## Locked default and explicitly bound staff release

With `auth: "locked"`, all staff pages/assets/APIs remain off (404), even with a signed cookie.
The separately commissioned `auth: "website"` mode requires both absolute private
`staffDatabaseFile` and `staffSecretFile` bindings, a dedicated read-only canonical
staff role, and peer-verified TLS. There is no fixture or public login mode.
No fixture credentials, staff table, minting endpoint or production secret is
installed. Healthy means the dedicated staging database is reachable under a
non-superuser/non-bypass-RLS role without ledger writes; it does NOT mean a
live accepted staff platform. `/health/live`, `/health/ready` and `/source` are
loopback-only operational endpoints. Readiness explicitly reports
`staffAccess: false`, `sending: false`, `customerDispatch: false`.

Live activation needs a commissioned server-side website-session binding,
least-privilege staff lookup, and scoped HTTPS ingress. Do not inject the website's
general-purpose privileged DB credential or a service-role key as a workaround.
Human sign-in acceptance is independent of synthetic browser commissioning.
Staff mode reports `staffAccess: true`, `sending: false`, `customerDispatch: false`
only when both DB readiness checks pass. Staff-DB failure denies authenticated
page/assets/API requests and returns readiness 503; no connection details are logged.

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

- `auth`: `locked`, or `website` with both explicit private bindings above.
- `websiteOrigin`: an exact HTTPS origin (no path/userinfo/query/fragment).
- `host`: defaults to `127.0.0.1`; `0.0.0.0` permitted ONLY inside an isolated
  container whose host publication is explicitly bound to 127.0.0.1.
- `port`: unused unprivileged port chosen after target inspection.
- `databaseFile`: absolute path to another private JSON file with `host`, `port`,
  `database`, `user`, `password`. Host is restricted to local Unix socket,
  loopback, or the isolated `newsletter-db` Docker alias. Remote database URLs
  and TLS overrides are unsupported for the newsletter database. Do not use transaction-pool endpoints.

The staff database JSON instead has `host`, `port`, `database` (postgres), `user`
(only isla_newsletter_staff_read with optional provider session-pool suffix),
`password`, `tlsServerName`, and `caFile`. Remote endpoints must be matching
Supabase session/direct host and TLS hostname, port 5432; `staff-db-proxy:4196`
is the sole isolated proxy alternative. Passwords must be at least 32 characters.
TLS always uses rejectUnauthorized=true, explicit provider CA, hostname checks
and minimum TLS 1.2. Never set sslmode=no-verify or disable peer verification.
`staffSecretFile` holds the server-owned website AUTH_SECRET reference material;
it is not JSON, remains mode 0400/0600, is never returned or used to mint cookies.
Only id,role,active are granted (see staff-read.sql). Never modify existing
policies, disable RLS, or reuse a colliding role. Check actual read/write denials.
Readiness also rejects schema CREATE, staff writes, owned application objects,
memberships and unrelated application-table column access. Standard catalog
metadata and extension-owned pg_stat_statements views retain the provider's
existing PUBLIC visibility; no additional grants are made to those objects.
Do not read/export their query-text rows as a commissioning probe.
If the website session secret rotates, replace only the private reference file
server-side and recreate only the newsletter app; do not rotate the website key.

An internal-network app can use a dedicated systemd-socket-proxyd socket bound
only to its private bridge gateway on 4196, forwarding only to the inspected
session-pool endpoint. Keep TLS end-to-end from the app with the original SNI.
Use a distinct new unit name, DynamicUser, no-new-privileges, IP allowlist for
the app and exact upstream addresses, filesystem/resource/log restrictions as
in loopback.service.in. No default route or general egress network is needed.
Store substituted endpoint/unit details privately, not in corresponding source.
If host ingress from the internal bridge is blocked, do not edit global firewall
rules. Instead use a NEW dedicated proxy container with the packaged
staff-db-proxy.mjs, on the internal app network and its own outbound bridge.
Only the proxy gets that bridge; app/DB remain internal without a default route.
Run the same pinned image, overriding entry point to node and supplying only
the exact allowed app IPv4 and fixed session-pool IPv4 as arguments. The proxy
has no credentials or mounts, publishes no port, accepts only that app address,
and forwards exclusively to the fixed target on 5432. TLS is NOT terminated.
Apply read-only root, non-root UID, cap-drop ALL, no-new-privileges, CPU/memory/PID
and log limits, restart policy and an explicit listener health check. Verify real
app TLS/role readiness and a disallowed-source denial. Stop/remove any unused
owned host proxy units; never restart unrelated services or weaken TLS.

newsletter-ingress.conf.in covers only the agreed same-site newsletter path.
Page/assets/API/source/preview independently recheck the signed website session
and current active role; admin writes additionally require exact Origin.
Operational /health and /source endpoints must NOT be forwarded publicly.
Before adding ingress, preserve the original file/hash and protected identities;
recheck the hash for concurrent edits, nginx -t, then graceful reload only.
Rollback removes only this run's marked include/addition; never overwrite a
concurrently changed nginx file. Keep prior app image/config and additive data.

The browser harness now exercises the runtime composition itself. Pass an
absolute artifact directory as its sole optional CLI argument to run the same
synthetic suite against the six-module artifact and standalone npm dependency
tree, verifying the exact release.json source link. It never reads production DB config.

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

On Docker versions that suppress port publication on internal networks, do NOT
add a public/egress-capable network merely to fix reachability. Keep both
containers internal and use the supplied systemd socket/proxy templates as new
dedicated `isla-newsletter-staging.socket` / `.service` units. Substitute the
freshly checked unused port, actual systemd-socket-proxyd path, and a stable
private container target IP/port; validate with `systemd-analyze verify` before
installing. The socket binds ONLY 127.0.0.1. The resource-bounded DynamicUser
proxy permits only loopback/the target IP and never handles credentials. Pin
the app's IP on recreation or regenerate/revalidate only these dedicated units.
Do not alter global Docker/firewall/nginx settings. Record actual host listener,
internal reachability and health after installation. Socket activation can keep
listening while the app is down: rollback must stop the dedicated socket AND
proxy before the app, and reactivate only those new units after verification.
No existing service needs a restart; systemd daemon-reload only loads new units.

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
