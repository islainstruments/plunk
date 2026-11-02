-- AGPL-3.0. Infrastructure applies ONLY in dedicated plunk_native DB.
-- Provision LOGIN role plunk_staff_test_operator with a random private password
-- separately; do not publish passwords or broaden plunk_native_runtime grants.
BEGIN;
ALTER ROLE plunk_staff_test_operator NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE plunk_native TO plunk_staff_test_operator;
GRANT USAGE ON SCHEMA public,isla_newsletter TO plunk_staff_test_operator;
GRANT SELECT ON public.projects,public.contacts,public.campaigns TO plunk_staff_test_operator;
GRANT SELECT ON ALL TABLES IN SCHEMA isla_newsletter TO plunk_staff_test_operator;
GRANT INSERT ON isla_newsletter.campaigns,isla_newsletter.deliveries,isla_newsletter.staff_test_authorizations,isla_newsletter.suppressions TO plunk_staff_test_operator;
GRANT UPDATE ON isla_newsletter.campaigns,isla_newsletter.deliveries,isla_newsletter.provider_throttle TO plunk_staff_test_operator;
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='isla_newsletter' LOOP
    EXECUTE format('DROP POLICY IF EXISTS staff_test_operator_read ON isla_newsletter.%I',t);
    EXECUTE format('CREATE POLICY staff_test_operator_read ON isla_newsletter.%I FOR SELECT TO plunk_staff_test_operator USING(true)',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['campaigns','deliveries','staff_test_authorizations','suppressions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS staff_test_operator_insert ON isla_newsletter.%I',t);
    EXECUTE format('CREATE POLICY staff_test_operator_insert ON isla_newsletter.%I FOR INSERT TO plunk_staff_test_operator WITH CHECK(true)',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['campaigns','deliveries','provider_throttle'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS staff_test_operator_update ON isla_newsletter.%I',t);
    EXECUTE format('CREATE POLICY staff_test_operator_update ON isla_newsletter.%I FOR UPDATE TO plunk_staff_test_operator USING(true) WITH CHECK(true)',t);
  END LOOP;
END $$;
COMMIT;
