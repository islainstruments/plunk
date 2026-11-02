/* Synthetic runtime binding tests; no production credentials. AGPL-3.0. */
import {createHmac} from 'node:crypto';

import type pg from 'pg';
import request from 'supertest';
import {describe, expect, it, vi} from 'vitest';

import {createRuntimeApp, runtimeConfig, staffDatabaseConfig} from '../NewsletterRuntime.js';

const secret = 'isolated-synthetic-staff-runtime-secret';
const revision = 'b'.repeat(40);
const metadata = {revision, source: 'https://github.com/islainstruments/plunk/tree/' + revision};
const config = runtimeConfig.parse({auth: 'website', websiteOrigin: 'https://staff.example.invalid',
  port: 4195, databaseFile: '/private/drafts.json', staffDatabaseFile: '/private/staff.json', staffSecretFile: '/private/key'});
const cookie = (id = 'synthetic-staff', exp = Date.now() + 60000) => {
  const body = Buffer.from(JSON.stringify({authUserId: id, exp})).toString('base64url');
  return 'isla_staff=' + body + '.' + createHmac('sha256', secret).update(body).digest('hex');
};
function fixture() {
  let active = true, unavailable = false, safe = true;
  const drafts = {query: vi.fn(async () => ({rows: [{unsafe: false, ledger_write: false}]}))} as unknown as pg.Pool;
  const query = vi.fn(async (sql: string) => {
    if (unavailable) throw new Error('synthetic private staff connection');
    if (sql.includes('AS safe')) return {rows: [{safe}]};
    if (sql.includes('WHERE id=$1')) return {rows: active ? [{id: 'synthetic-staff', role: 'viewer'}] : []};
    return {rows: []};
  });
  const app = createRuntimeApp(config, drafts, metadata, {pool: {query} as unknown as pg.Pool, secret});
  return {app, query, revoke: () => { active = false; }, outage: () => { unavailable = true; }, unsafe: () => { safe = false; }};
}
describe('scoped website runtime composition', () => {
  it('requires all explicit private bindings and rejects unsafe connection configuration', () => {
    expect(() => createRuntimeApp(config, {} as pg.Pool, metadata)).toThrow('binding required');
    expect(runtimeConfig.safeParse({...config, staffSecretFile: undefined}).success).toBe(false);
    const db = {host: 'staff-db-proxy', port: 4196, database: 'postgres', user: 'isla_newsletter_staff_read',
      password: 'x'.repeat(48), tlsServerName: 'aws-0-region.pooler.supabase.com', caFile: '/private/ca.crt'};
    expect(staffDatabaseConfig.safeParse(db).success).toBe(true);
    for (const value of [{...db, user: 'postgres'}, {...db, ssl: false}, {...db, host: 'example.invalid'},
      {...db, tlsServerName: 'localhost'}, {...db, port: 6543}, {...db, password: 'short'}, {...db, connectionString: 'postgres://invalid'}])
      expect(staffDatabaseConfig.safeParse(value).success).toBe(false);
  });
  it('protects page/assets/source/API independently and pins corresponding source', async () => {
    const {app} = fixture();
    for (const path of ['/staff/newsletters', '/staff/newsletters/editor.js', '/staff/newsletters/editor.css', '/staff/newsletters/source', '/staff/newsletters/api/drafts'])
      expect((await request(app).get(path)).status).toBe(401);
    const page = await request(app).get('/staff/newsletters').set('Cookie', cookie());
    expect(page.status).toBe(200); expect(page.text).toContain(metadata.source); expect(page.headers.link).toContain(revision);
    expect((await request(app).get('/staff/newsletters/source').set('Cookie', cookie())).body.source).toBe(metadata.source);
    for (const path of ['/v1/send', '/auth/login', '/auth/signup', '/webhooks/resend', '/api/newsletters/imports'])
      expect((await request(app).post(path).set('Cookie', cookie())).status).toBe(404);
  });
  it('rechecks revocation/expiry and denies non-admin writes', async () => {
    const f = fixture();
    expect((await request(f.app).get('/staff/newsletters').set('Cookie', cookie('synthetic-staff', 1))).status).toBe(401);
    expect((await request(f.app).post('/staff/newsletters/api/drafts').set('Cookie', cookie()).set('Origin', config.websiteOrigin)).status).toBe(403);
    f.revoke(); expect((await request(f.app).get('/staff/newsletters').set('Cookie', cookie())).status).toBe(401);
  });
  it('fails staff lookup and readiness closed on staff DB failure without leaking details', async () => {
    const f = fixture();
    expect((await request(f.app).get('/health/ready')).body).toMatchObject({staffAccess: true, sending: false, customerDispatch: false});
    f.outage();
    for (const path of ['/health/ready', '/staff/newsletters', '/staff/newsletters/editor.js', '/staff/newsletters/api/drafts']) {
      const response = await request(f.app).get(path).set('Cookie', cookie());
      expect(response.status).toBe(503); expect(response.text).not.toContain('private staff connection');
    }
    expect((await request(f.app).get('/health/live')).status).toBe(200);
  });
  it('rejects unsafe staff role readiness', async () => {
    const f = fixture(); f.unsafe(); expect((await request(f.app).get('/health/ready')).status).toBe(503);
  });
});
