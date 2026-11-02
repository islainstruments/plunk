-- ISLA modifications to Plunk, licensed AGPL-3.0; additive commissioning schema.
-- Apply only to an explicitly selected newsletter database. Never run on startup.
CREATE SCHEMA IF NOT EXISTS isla_newsletter;
-- Draft editing has no contact/campaign/delivery relationship or dispatch trigger.
CREATE TABLE IF NOT EXISTS isla_newsletter.drafts (
  id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  content jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS isla_newsletter.draft_revisions (
  draft_id text NOT NULL REFERENCES isla_newsletter.drafts(id),
  revision integer NOT NULL,
  content jsonb NOT NULL,
  saved_by text NOT NULL,
  saved_at timestamptz NOT NULL,
  PRIMARY KEY(draft_id,revision)
);
CREATE OR REPLACE FUNCTION isla_newsletter.record_draft_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO isla_newsletter.draft_revisions(draft_id,revision,content,saved_by,saved_at)
  VALUES(NEW.id,NEW.revision,NEW.content,NEW.updated_by,NEW.updated_at);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS draft_revision ON isla_newsletter.drafts;
CREATE TRIGGER draft_revision AFTER INSERT OR UPDATE ON isla_newsletter.drafts
FOR EACH ROW EXECUTE FUNCTION isla_newsletter.record_draft_revision();
-- Native campaign plain text is separate from HTML, never regenerated on save.
CREATE TABLE IF NOT EXISTS isla_newsletter.native_content (
  campaign_id text PRIMARY KEY,
  project_id text NOT NULL,
  plain_text text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS isla_newsletter.contacts (
  email text PRIMARY KEY CHECK (email = lower(trim(email))),
  provenance jsonb NOT NULL,
  prior_sends jsonb NOT NULL DEFAULT '[]',
  review boolean NOT NULL DEFAULT true,
  consent_evidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS isla_newsletter.suppressions (
  email text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('unsubscribe','hard_bounce','complaint','withdrawal','quarantine')),
  source text NOT NULL,
  source_event_id text NOT NULL,
  effective_at timestamptz NOT NULL,
  PRIMARY KEY (email, reason, source, source_event_id)
);
CREATE INDEX IF NOT EXISTS suppressions_email ON isla_newsletter.suppressions(email);
-- Durable outbox acknowledgement, never suppression deletion. A failed remote
-- write leaves the event pending; replay after a remote commit is idempotent.
CREATE TABLE IF NOT EXISTS isla_newsletter.suppression_exports (
  email text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  source_event_id text NOT NULL,
  exported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(email,reason,source,source_event_id),
  FOREIGN KEY(email,reason,source,source_event_id)
    REFERENCES isla_newsletter.suppressions(email,reason,source,source_event_id)
);
CREATE TABLE IF NOT EXISTS isla_newsletter.campaigns (
  id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','paused','running','complete')),
  purpose text NOT NULL CHECK (purpose IN ('test','customer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE isla_newsletter.campaigns ADD COLUMN IF NOT EXISTS content_version text;
-- ISLA 2026-11-02: atomic frozen audience; only the preparation cursor mutates.
CREATE TABLE IF NOT EXISTS isla_newsletter.audience_manifests (
  campaign_id text PRIMARY KEY REFERENCES isla_newsletter.campaigns(id),
  version text NOT NULL,
  selection jsonb NOT NULL,
  exclusions jsonb NOT NULL,
  prepared_cursor text,
  frozen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS isla_newsletter.audience_members (
  campaign_id text NOT NULL REFERENCES isla_newsletter.audience_manifests(campaign_id),
  contact_id text NOT NULL,
  email text NOT NULL,
  personalization jsonb NOT NULL,
  exclusion text,
  PRIMARY KEY(campaign_id,contact_id),
  UNIQUE(campaign_id,email)
);
CREATE OR REPLACE FUNCTION isla_newsletter.freeze_audience() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='audience_members' THEN
    RAISE EXCEPTION 'Audience membership is immutable';
  ELSIF ROW(NEW.campaign_id,NEW.version,NEW.selection,NEW.exclusions,NEW.frozen_at)
    IS DISTINCT FROM ROW(OLD.campaign_id,OLD.version,OLD.selection,OLD.exclusions,OLD.frozen_at) THEN
    RAISE EXCEPTION 'Audience definition is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_audience ON isla_newsletter.audience_members;
CREATE TRIGGER immutable_audience BEFORE UPDATE OR DELETE ON isla_newsletter.audience_members
  FOR EACH ROW EXECUTE FUNCTION isla_newsletter.freeze_audience();
DROP TRIGGER IF EXISTS immutable_manifest ON isla_newsletter.audience_manifests;
CREATE TRIGGER immutable_manifest BEFORE UPDATE ON isla_newsletter.audience_manifests
  FOR EACH ROW EXECUTE FUNCTION isla_newsletter.freeze_audience();
CREATE TABLE IF NOT EXISTS isla_newsletter.deliveries (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES isla_newsletter.campaigns(id),
  recipient text NOT NULL REFERENCES isla_newsletter.contacts(email),
  content_version text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','accepted','skipped','review')),
  first_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  provider_id text UNIQUE,
  accepted_at timestamptz,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, content_version, recipient)
);
CREATE INDEX IF NOT EXISTS deliveries_due ON isla_newsletter.deliveries(status,next_attempt_at);
-- Exactly one operational commissioning delivery for Brad's recorded release.
CREATE TABLE IF NOT EXISTS isla_newsletter.staff_test_authorizations (
  authorization_id text PRIMARY KEY CHECK (authorization_id='brad-2026-11-02-one-test'),
  delivery_id text NOT NULL UNIQUE REFERENCES isla_newsletter.deliveries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION isla_newsletter.freeze_staff_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Staff test authorization is immutable';
END $$;
DROP TRIGGER IF EXISTS immutable_staff_test ON isla_newsletter.staff_test_authorizations;
CREATE TRIGGER immutable_staff_test BEFORE UPDATE OR DELETE ON isla_newsletter.staff_test_authorizations
  FOR EACH ROW EXECUTE FUNCTION isla_newsletter.freeze_staff_test();
CREATE TABLE IF NOT EXISTS isla_newsletter.provider_events (
  event_id text PRIMARY KEY,
  provider_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_events_message ON isla_newsletter.provider_events(provider_id);
-- ISLA 2026-11-02: Only an explicitly Permanent bounce is a hard bounce.
-- Older/missing/Temporary classifications remain a conservative review veto.
ALTER TABLE isla_newsletter.provider_events ADD COLUMN IF NOT EXISTS bounce_type text;
-- Shared limiter for all newsletter workers in this database, including restarts.
CREATE TABLE IF NOT EXISTS isla_newsletter.provider_throttle (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO isla_newsletter.provider_throttle(singleton) VALUES(true) ON CONFLICT DO NOTHING;
-- Application updates may change outcomes, never the frozen recipient/body/key.
CREATE OR REPLACE FUNCTION isla_newsletter.freeze_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.campaign_id,NEW.recipient,NEW.content_version,NEW.payload,NEW.idempotency_key,NEW.token_hash)
     IS DISTINCT FROM ROW(OLD.id,OLD.campaign_id,OLD.recipient,OLD.content_version,OLD.payload,OLD.idempotency_key,OLD.token_hash) THEN
    RAISE EXCEPTION 'Delivery identity and payload are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_delivery ON isla_newsletter.deliveries;
CREATE TRIGGER immutable_delivery BEFORE UPDATE ON isla_newsletter.deliveries FOR EACH ROW EXECUTE FUNCTION isla_newsletter.freeze_delivery();
-- Tables intentionally expose no public privileges. Provision a scoped server role
-- separately; do not grant access to Supabase anon/authenticated client roles.
REVOKE ALL ON SCHEMA isla_newsletter FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA isla_newsletter FROM PUBLIC;
-- Fail closed even where a hosted database has permissive default privileges.
ALTER TABLE isla_newsletter.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.native_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.draft_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.suppression_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.audience_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.audience_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.staff_test_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.provider_throttle ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA isla_newsletter FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA isla_newsletter FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
