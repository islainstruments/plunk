# ISLA newsletter commissioning components

ISLA modifications to Plunk, licensed under AGPL-3.0. Preserve the upstream
LICENSE and make corresponding source/build instructions available to network
users. This directory is an implementation checkpoint, **not a deployed system**.

## What works in isolation

- PostgreSQL delivery ledger with immutable request/recipient/key, serialized
  campaign and recipient operations, persisted attempt state, newsletter-shared
  throttling and a 23-hour automatic retry window (Resend keys expire at 24 hours).
- Default-off delivery; the only configurable enabled mode is designated
  staff-test delivery. Customer dispatch has no enabled implementation.
- Additive suppression events and provenance/history-preserving imports. Imports
  cannot remove suppression or clear a review flag. Public migration remains locked.
- Purpose-specific opaque unsubscribe tokens, confirmation-only GET and no-login
  POST, with no account/order/product-access mutations.
- Raw-body Svix verification, duplicate-event reconciliation, early-event
  reconciliation and sticky bounce/complaint/provider-suppressed handling.
- Website-compatible signed staff session validation and fresh active-role lookup;
  active staff reads, admin writes, required same-origin writes, locked customer
  dispatch/import routes.
- Analytics separate acceptance from verified provider event facts, and distinguish
  total provider events from unique messages. Tracking remains uncommissioned.

`NewsletterRouter` must be deliberately mounted **before JSON body parsing** so
webhook verification receives original bytes. It is not a security wrapper for
unmodified upstream Plunk routes. Do not expose the upstream dashboard/API until
all alternate authentication, public signup and delivery paths are integrated.

## Non-sending verification

Install repository dependencies with `corepack yarn install --immutable`.
The fixture suite requires PostgreSQL 17 binaries and an isolated cluster under
this infrastructure profile's private scratch directory. It deliberately does
not read `DATABASE_URL` or production credentials. Use database
`isla_newsletter_fixture`, port `55439`, Unix socket `$TMPDIR`, no TCP listener:

```sh
/usr/lib/postgresql/17/bin/initdb -D "$TMPDIR/newsletter-pg" -A trust --no-locale -E UTF8
/usr/lib/postgresql/17/bin/postgres -D "$TMPDIR/newsletter-pg" -k "$TMPDIR" -h '' -p 55439
# In another shell, once readiness succeeds:
pg_isready -h "$TMPDIR" -p 55439
createdb -h "$TMPDIR" -p 55439 isla_newsletter_fixture
corepack yarn tsc -p tsconfig.isla.json
corepack yarn vitest run --config vitest.isla.config.ts
```

The suite uses `.invalid` fixture addresses, fixture signing keys and injected
mock provider responses. It forbids the global network send path. It includes a
real worker SIGKILL after mock provider acceptance, reconnect/retry, concurrency,
CSRF, opt-out and event replay tests. These are **not live Resend delivery results**.
Schema creation and TRUNCATE operations are restricted to the named local fixture
database by the test harness. Never point this harness at production.

## Integration and operational gates still open

This library is not yet connected to the Plunk editor/API/queue. The schema SQL
is not an approved production migration and must never auto-apply on startup.
Use a direct/session PostgreSQL connection: session advisory locks are incompatible
with transaction-pooling connections. Select scoped server-role grants/RLS
policies separately; no anonymous or browser access is intended.

The injected `eligibility` callback must check canonical marketing state and fail
closed; a test callback returning true is not a production consent integration.
Website/Supabase synchronization, initial contact reconciliation, editor integration,
HTTPS/ingress, process supervision, health checks, asset storage, account-wide
quota coordination and live tracking configuration remain uncommissioned.
No production Resend credential is needed for these tests.

Before activation, exercise consistent backup/isolated restore and rollback.
Preserve the delivery ledger, suppression events and provider event facts across
rollbacks. Never overwrite a live ledger with an older backup then resume sends.
Uncertain attempts beyond the retry window require provider/manual reconciliation,
not a new idempotency key or blind retry. Keep sending disabled during restore.

No customer import or send is authorized during commissioning. Real staff test
sends additionally require explicitly designated addresses and the chosen From
identity and monitored Reply-To. Existing transactional email remains untouched.
