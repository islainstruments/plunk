/* Real local PostgreSQL fixtures only. No production credentials or contacts. */
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {CanonicalMarketing} from '../CanonicalMarketing.js';

const socket = process.env.TMPDIR;
if (!(socket && /\/isla-(?:infrastructure|software)\/cache\/scratch/.test(socket))) throw new Error('Fixture socket required');
const pool = new pg.Pool({host: socket, port: 55439, database: 'isla_newsletter_fixture'});
const address = 'canonical@example.invalid';
let integration: CanonicalMarketing;
beforeAll(async () => {
  expect((await pool.query('SELECT current_database() AS db')).rows[0].db).toBe('isla_newsletter_fixture');
  await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await pool.query(`CREATE TABLE IF NOT EXISTS public.reborn_marketing_subscriptions(email text PRIMARY KEY,subscribed boolean,withdrawn_at timestamptz);
    CREATE TABLE IF NOT EXISTS public.product_release_notifications(email text PRIMARY KEY,status text,withdrawn_at timestamptz)`);
  await pool.query(await readFile(new URL('../canonical-marketing.sql', import.meta.url), 'utf8'));
  await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='marketing_fixture') THEN
    CREATE ROLE marketing_fixture NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
    GRANT USAGE ON SCHEMA isla_marketing TO marketing_fixture;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA isla_marketing TO marketing_fixture`);
});
beforeEach(async () => {
  await pool.query(`TRUNCATE isla_marketing.suppressions,isla_newsletter.suppressions,
    public.reborn_marketing_subscriptions,public.product_release_notifications CASCADE`);
  integration = new CanonicalMarketing(pool, pool);
});
afterAll(async () => {await pool.end();});
describe('canonical marketing veto and durable suppression export', () => {
  it('normalizes and reads current website withdrawals without mutating subscription or access', async () => {
    expect(await integration.eligible(address)).toBe(true); // veto only, not consent
    await pool.query('INSERT INTO public.reborn_marketing_subscriptions VALUES($1,false,now())', [address]);
    expect(await integration.eligible(address.toUpperCase())).toBe(false);
    await pool.query('DELETE FROM public.reborn_marketing_subscriptions');
    await pool.query("INSERT INTO public.product_release_notifications VALUES($1,'withdrawn',now())", [address]);
    expect(await integration.eligible(address)).toBe(false);
    expect((await pool.query('SELECT status FROM public.product_release_notifications')).rows[0].status).toBe('withdrawn');
  });
  it('exports idempotently, survives lost local acknowledgement and vetoes fresh imports', async () => {
    await pool.query("INSERT INTO isla_newsletter.suppressions VALUES($1,'unsubscribe','newsletter','fixture',now())", [address]);
    expect(await integration.synchronize()).toBe(1);
    expect(await integration.synchronize()).toBe(0);
    expect(await integration.eligible(address)).toBe(false);
    await pool.query('DELETE FROM isla_newsletter.suppression_exports'); // crash before ACK
    expect(await integration.synchronize()).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM isla_marketing.suppressions')).rows[0].n).toBe(1);
  });
  it('keeps pending events on remote failure and never caches eligibility across outages', async () => {
    await pool.query("INSERT INTO isla_newsletter.suppressions VALUES($1,'complaint','resend','fixture',now())", [address]);
    const unavailable = new CanonicalMarketing(pool, {query: async () => {throw new Error('synthetic outage');}} as unknown as pg.Pool);
    await expect(unavailable.synchronize()).rejects.toThrow('synthetic outage');
    await expect(unavailable.eligible(address)).rejects.toThrow('synthetic outage');
    expect((await pool.query('SELECT count(*)::int AS n FROM isla_newsletter.suppression_exports')).rows[0].n).toBe(0);
    expect(await integration.synchronize()).toBe(1);
  });
  it('restricts runtime role to veto/append functions, not website records or suppression deletion', async () => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE marketing_fixture');
      expect((await client.query('SELECT isla_marketing.not_suppressed($1) AS ok', [address])).rows[0].ok).toBe(true);
      await client.query("SELECT isla_marketing.record_suppression($1,'hard_bounce','fixture','id',now())", [address]);
      expect((await client.query('SELECT isla_marketing.not_suppressed($1) AS ok', [address])).rows[0].ok).toBe(false);
      for (const sql of ['DELETE FROM isla_marketing.suppressions', 'SELECT * FROM public.reborn_marketing_subscriptions', 'UPDATE public.product_release_notifications SET status=\'subscribed\'']) {
        await expect(client.query(sql)).rejects.toThrow();
      }
    } finally {await client.query('RESET ROLE'); client.release();}
  });
});
