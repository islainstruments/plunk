-- ISLA modifications, AGPL-3.0. Additive Supabase marketing veto store.
-- No account/order/licence/transactional or ReBorn access mutations.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE SCHEMA IF NOT EXISTS isla_marketing;
REVOKE ALL ON SCHEMA isla_marketing FROM PUBLIC;
CREATE TABLE IF NOT EXISTS isla_marketing.suppressions (
  email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  reason text NOT NULL CHECK(reason IN ('unsubscribe','hard_bounce','complaint','withdrawal','quarantine')),
  source text NOT NULL,
  source_event_id text NOT NULL,
  effective_at timestamptz NOT NULL,
  PRIMARY KEY(email,reason,source,source_event_id)
);
ALTER TABLE isla_marketing.suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA isla_marketing FROM PUBLIC;
-- SECURITY DEFINER functions are the only intended runtime interface. Their owner
-- must be a migration role able to read the existing RLS-protected website tables.
CREATE OR REPLACE FUNCTION isla_marketing.record_suppression(
  address text, why text, origin text, event_id text, occurred_at timestamptz
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  INSERT INTO isla_marketing.suppressions(email,reason,source,source_event_id,effective_at)
  VALUES(lower(btrim(address)),why,origin,event_id,occurred_at) ON CONFLICT DO NOTHING;
$$;
CREATE OR REPLACE FUNCTION isla_marketing.not_suppressed(address text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(SELECT 1 FROM isla_marketing.suppressions s WHERE s.email=lower(btrim(address)))
    AND NOT EXISTS(SELECT 1 FROM public.reborn_marketing_subscriptions r
      WHERE lower(btrim(r.email))=lower(btrim(address)) AND (NOT r.subscribed OR r.withdrawn_at IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM public.product_release_notifications n
      WHERE n.email=lower(btrim(address)) AND (n.status='withdrawn' OR n.withdrawn_at IS NOT NULL));
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA isla_marketing FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA isla_marketing FROM %I',r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA isla_marketing FROM %I',r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA isla_marketing FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
-- Provision a separate server login: USAGE on isla_marketing + EXECUTE on the
-- two functions only. Never grant it SELECT on auth.users or consent tables.
-- This is a veto, NOT evidence of consent. Positive scope/provenance remains in
-- the reviewed newsletter ledger. No existing record is imported by this DDL.
