-- ISLA dedicated canonical staff lookup grants. AGPL-3.0.
-- Execute in a checked transaction only after collision-free server-side creation
-- of isla_newsletter_staff_read LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB
-- NOCREATEROLE NOREPLICATION NOINHERIT, with a generated private password.
-- Never alter an existing role, existing policy, staff row or RLS setting.
GRANT CONNECT ON DATABASE postgres TO isla_newsletter_staff_read;
GRANT USAGE ON SCHEMA public TO isla_newsletter_staff_read;
GRANT SELECT (id,role,active) ON public.staff_users TO isla_newsletter_staff_read;
-- Only needed when the inspected canonical table has RLS enabled.
CREATE POLICY isla_newsletter_staff_read_active ON public.staff_users
  FOR SELECT TO isla_newsletter_staff_read USING (active = true);
-- Verify current_user/flags/memberships, TLS peer authorization and exact lookup
-- using a nonexistent UUID. Denial probes use LIMIT 0 / WHERE false, never PII.
