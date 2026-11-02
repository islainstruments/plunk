-- Dedicated newsletter DB only, after schema.sql; role created privately by operator.
-- Never run against canonical website tables. AGPL-3.0.
GRANT CONNECT ON DATABASE newsletter_staging TO newsletter_runtime;
GRANT USAGE ON SCHEMA isla_newsletter TO newsletter_runtime;
GRANT SELECT, INSERT, UPDATE ON isla_newsletter.drafts TO newsletter_runtime;
GRANT SELECT, INSERT ON isla_newsletter.draft_revisions TO newsletter_runtime;
CREATE POLICY draft_runtime ON isla_newsletter.drafts TO newsletter_runtime USING (true) WITH CHECK (true);
CREATE POLICY draft_history_runtime ON isla_newsletter.draft_revisions TO newsletter_runtime USING (true) WITH CHECK (true);
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA isla_newsletter FROM newsletter_runtime;
