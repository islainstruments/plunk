-- ISLA modifications to Plunk, licensed AGPL-3.0; additive commissioning schema.
-- Apply only to an explicitly selected newsletter database. Never run on startup.
CREATE SCHEMA IF NOT EXISTS isla_newsletter;
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
CREATE TABLE IF NOT EXISTS isla_newsletter.campaigns (
  id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','paused','running','complete')),
  purpose text NOT NULL CHECK (purpose IN ('test','customer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE TABLE IF NOT EXISTS isla_newsletter.provider_events (
  event_id text PRIMARY KEY,
  provider_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_events_message ON isla_newsletter.provider_events(provider_id);
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
ALTER TABLE isla_newsletter.suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE isla_newsletter.deliveries ENABLE ROW LEVEL SECURITY;
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
