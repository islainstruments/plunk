import {execFile} from 'node:child_process';
import {createHmac, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

import pg from 'pg';
import request from 'supertest';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {createNewsletterDraftApp} from '../NewsletterDraftApp.js';
import {NewsletterDrafts} from '../NewsletterDrafts.js';
import {NewsletterLedger} from '../NewsletterLedger.js';

const socket = process.env.TMPDIR;
if (!socket || !/\/isla-(?:infrastructure|software)\/cache\/scratch/.test(socket)) throw new Error('Private fixture socket required');
const connection = {host: socket, port: 55439, database: 'isla_newsletter_fixture', user: userInfo().username, password: ''};
const pool = new pg.Pool(connection);
const secret = 'fixture-only-auth-secret-at-least-thirty-two-characters';
const origin = 'https://staff.example.invalid';
const base = '/staff/newsletters/api/drafts';
const content = {subject: 'Synthetic draft', html: '<p>Hello</p><img src="https://assets.example.invalid/art.png" alt="Art">', text: 'Original independent plain text.\nSecond line.'};
const store = new NewsletterDrafts(pool);
const app = (enabled: boolean | undefined = true) => createNewsletterDraftApp({enabled, websiteOrigin: origin, staffSecret: secret, staffDb: pool, newsletterDb: pool});
function cookie(user = 'admin-draft', exp = Date.now() + 60000) {
  const encoded = Buffer.from(JSON.stringify({exp, authUserId: user})).toString('base64url');
  return `isla_staff=${encoded}.${createHmac('sha256', secret).update(encoded).digest('hex')}`;
}
function save(a = app(), user = 'admin-draft', from = origin) {
  return request(a).post(base).set('Cookie', cookie(user)).set('Origin', from);
}
beforeAll(async () => {
  if ((await pool.query('SELECT current_database() AS db')).rows[0].db !== connection.database) throw new Error('Not fixture');
  await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await pool.query('CREATE TABLE IF NOT EXISTS public.staff_users(id text PRIMARY KEY,role text,active boolean)');
});
beforeEach(async () => {
  await pool.query('TRUNCATE isla_newsletter.drafts,isla_newsletter.draft_revisions,isla_newsletter.provider_events,isla_newsletter.deliveries,isla_newsletter.campaigns,isla_newsletter.contacts,isla_newsletter.suppressions,public.staff_users CASCADE');
  await pool.query("INSERT INTO public.staff_users VALUES('admin-draft','admin',true),('viewer-draft','viewer',true),('inactive-draft','admin',false),('support-draft','support_agent',true),('developer-draft','developer',true)");
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real network forbidden'); }));
});
afterAll(async () => { vi.unstubAllGlobals(); await pool.end(); });

describe('authenticated draft-only HTTP composition (real isolated PostgreSQL)', () => {
  it('gates dedicated editor and assets with the same live staff boundary and default-off flag', async () => {
    for (const path of ['/staff/newsletters', '/staff/newsletters/', '/staff/newsletters/editor.js', '/staff/newsletters/editor.css']) {
      expect((await request(app()).get(path)).status).toBe(401);
      expect((await request(app()).get(path).set('Cookie', cookie('inactive-draft'))).status).toBe(401);
      expect((await request(app(false)).get(path).set('Cookie', cookie())).status).toBe(404);
      const result = await request(app()).get(path).set('Cookie', cookie('viewer-draft'));
      expect(result.status).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
    }
  });
  it('serves a dedicated CSP-protected editor with source access, not the upstream root dashboard', async () => {
    const page = await request(app()).get('/staff/newsletters').set('Cookie', cookie());
    expect(page.text).toContain('data-role="admin"');
    expect(page.text).toContain('All sending and customer dispatch disabled');
    expect(page.text).toContain('Complete corresponding source and build instructions');
    expect(page.text).toContain('src="/staff/newsletters/editor.js"');
    expect(page.text).toContain('sandbox referrerpolicy="no-referrer"');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).not.toContain('unsafe-inline');
    const viewer = await request(app()).get('/staff/newsletters').set('Cookie', cookie('viewer-draft'));
    expect(viewer.text).toContain('data-role="viewer"');
    for (const path of ['/', '/projects', '/auth/login']) expect((await request(app()).get(path)).status).toBe(404);
  });
  it('never interpolates stored draft source or subjects into the editor document', async () => {
    await store.create({...content, subject: '<script>window.injected=1</script>', html: '<script>window.injected=2</script>'}, 'fixture');
    const page = await request(app()).get('/staff/newsletters').set('Cookie', cookie());
    expect(page.text).not.toContain('window.injected');
    const script = await request(app()).get('/staff/newsletters/editor.js').set('Cookie', cookie());
    expect(script.headers['content-type']).toContain('application/javascript');
    expect(script.text).not.toContain('innerHTML');
    expect(script.text).toContain('textContent');
  });
  it('is default-off and exposes only non-sensitive liveness without authentication', async () => {
    const disabled = createNewsletterDraftApp({websiteOrigin: origin, staffSecret: secret, staffDb: pool, newsletterDb: pool});
    expect((await save(disabled).send(content)).status).toBe(404);
    expect((await request(disabled).get('/health/live')).body).toEqual({alive: true, sending: false});
  });
  it('creates, reloads, edits and previews a draft while preserving independent text and audited revisions', async () => {
    const a = app();
    const created = await save(a).send(content);
    expect(created.status).toBe(201);
    const path = `${base}/${created.body.id}`;
    expect(created.headers.location).toBe(path);
    expect((await request(a).get(path).set('Cookie', cookie('viewer-draft'))).body.content).toEqual(content);
    const edited = {...content, subject: 'Revised synthetic draft'};
    const result = await request(a).put(path).set('Cookie', cookie()).set('Origin', origin).send({revision: 1, content: edited});
    expect(result.status).toBe(200);
    expect(result.body.revision).toBe(2);
    expect((await request(a).get(`${path}/preview?format=text`).set('Cookie', cookie())).text).toBe(content.text);
    const html = await request(a).get(`${path}/preview`).set('Cookie', cookie());
    expect(html.text).toContain('<p>Hello</p>');
    expect(html.text).toContain('src="https://assets.example.invalid/art.png" alt="Art"');
    expect(html.headers['content-security-policy']).toContain("sandbox; default-src 'none'");
    expect(html.headers['cache-control']).toBe('private, no-store');
    expect(html.headers.link).toContain('https://github.com/islainstruments/plunk/tree/isla/resend-staff');
    const revisions = await pool.query('SELECT revision,content,saved_by FROM isla_newsletter.draft_revisions ORDER BY revision');
    expect(revisions.rows).toEqual([{revision: 1, content, saved_by: 'admin-draft'}, {revision: 2, content: edited, saved_by: 'admin-draft'}]);
    for (const table of ['contacts', 'campaigns', 'deliveries']) expect((await pool.query(`SELECT count(*)::int AS n FROM isla_newsletter.${table}`)).rows[0].n).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('does not allow anonymous, expired, tampered, duplicate-cookie or inactive sessions to read or preview', async () => {
    const draft = await store.create(content, 'fixture');
    for (const value of ['', cookie('inactive-draft'), cookie('admin-draft', Date.now() - 1000), cookie() + 'a', cookie() + '; ' + cookie()]) {
      for (const suffix of ['', `/${draft.id}`, `/${draft.id}/preview`])
        expect((await request(app()).get(base + suffix).set('Cookie', value)).status).toBe(401);
    }
  });
  it.each(['viewer-draft', 'support-draft', 'developer-draft'])('allows %s read/preview but denies create/edit', async user => {
    const draft = await store.create(content, 'fixture');
    expect((await request(app()).get(`${base}/${draft.id}/preview`).set('Cookie', cookie(user))).status).toBe(200);
    expect((await save(app(), user).send(content)).status).toBe(403);
    expect((await request(app()).put(`${base}/${draft.id}`).set('Cookie', cookie(user)).set('Origin', origin).send({revision: 1, content})).status).toBe(403);
  });
  it('requires exact same-origin writes and checks live role revocation on existing cookies', async () => {
    for (const from of ['https://attacker.example.invalid', 'null', origin + '/']) expect((await save(app(), 'admin-draft', from).send(content)).status).toBe(403);
    expect((await request(app()).post(base).set('Cookie', cookie()).send(content)).status).toBe(403);
    const a = app();
    const session = cookie();
    expect((await request(a).get(base).set('Cookie', session)).status).toBe(200);
    await pool.query("UPDATE public.staff_users SET role='viewer' WHERE id='admin-draft'");
    expect((await request(a).post(base).set('Cookie', session).set('Origin', origin).send(content)).status).toBe(403);
    await pool.query("UPDATE public.staff_users SET active=false WHERE id='admin-draft'");
    expect((await request(a).get(base).set('Cookie', session)).status).toBe(401);
  });
  it('rejects lost-update races with 409 and stores exactly one winning revision', async () => {
    const draft = await store.create(content, 'fixture');
    const a = app();
    const results = await Promise.all(['First', 'Second'].map(subject => request(a).put(`${base}/${draft.id}`).set('Cookie', cookie()).set('Origin', origin).send({revision: 1, content: {...content, subject}})));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await store.get(draft.id))!.revision).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS n FROM isla_newsletter.draft_revisions')).rows[0].n).toBe(2);
  });
  it('pins preview HTML and text to an audited saved revision even after later edits', async () => {
    const draft = await store.create(content, 'fixture');
    await store.update(draft.id, 1, {...content, html: '<p>New saved HTML</p>', text: 'New independent text'}, 'fixture');
    const path = `${base}/${draft.id}/preview`;
    const old = await request(app()).get(path + '?revision=1').set('Cookie', cookie('viewer-draft'));
    expect(old.text).toContain('<p>Hello</p>');
    expect(old.text).not.toContain('New saved HTML');
    expect((await request(app()).get(path + '?revision=1&format=text').set('Cookie', cookie())).text).toBe(content.text);
    expect((await request(app()).get(path + '?revision=2').set('Cookie', cookie())).text).toContain('New saved HTML');
    expect((await request(app()).get(path + '?revision=3').set('Cookie', cookie())).status).toBe(404);
    for (const value of ['0', '-1', 'abc', '2147483648']) expect((await request(app()).get(path).query({revision: value}).set('Cookie', cookie())).status).toBe(400);
  });
  it('rejects dispatch fields, empty text, header injection, malformed JSON, oversized bodies and invalid IDs', async () => {
    for (const bad of [{...content, to: ['synthetic@example.invalid']}, {...content, from: 'synthetic@example.invalid'}, {...content, text: ' '}, {...content, subject: 'x\r\nBcc: x'}])
      expect((await save().send(bad)).status).toBe(400);
    expect((await save().type('json').send('{')).status).toBe(400);
    expect((await save().send({...content, html: 'a'.repeat(1100000)})).status).toBe(413);
    expect((await request(app()).get(base + '/not-an-id').set('Cookie', cookie())).status).toBe(400);
    expect((await request(app()).get(base + '/' + randomUUID()).set('Cookie', cookie())).status).toBe(404);
    expect((await request(app()).get(base + '?after=invalid').set('Cookie', cookie())).status).toBe(400);
  });
  it('sanitizes hostile preview HTML without altering stored source, and never fetches assets', async () => {
    const hostile = {...content, html: '<script>alert(1)</script><img src="https://assets.example.invalid/a" onerror="alert(2)"><iframe src="https://example.invalid"></iframe><form action="/staff"><input></form><a href="javascript:alert(3)">Link</a>'};
    const created = await save().send(hostile);
    const result = await request(app()).get(`${base}/${created.body.id}/preview`).set('Cookie', cookie());
    expect(result.status).toBe(200);
    for (const bad of ['<script', 'onerror', '<iframe', '<form', 'javascript:']) expect(result.text).not.toContain(bad);
    expect(result.headers['content-security-policy']).not.toContain('img-src');
    expect((await store.get(created.body.id))!.content).toEqual(hostile);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('paginates bounded summaries without returning HTML/text bodies or repeating drafts', async () => {
    for (let i = 0; i < 23; i++) await store.create({...content, subject: `Synthetic ${i}`}, 'fixture');
    const first = (await request(app()).get(base).set('Cookie', cookie())).body;
    const second = (await request(app()).get(base).query({after: first.next}).set('Cookie', cookie())).body;
    expect(first.drafts).toHaveLength(20);
    expect(second.drafts).toHaveLength(3);
    expect(second.next).toBeNull();
    expect(new Set([...first.drafts, ...second.drafts].map(d => d.id)).size).toBe(23);
    expect(first.drafts[0].content).toBeUndefined();
  });
  it('returns readiness only after auth and fails closed on database errors without leaking details', async () => {
    expect((await request(app()).get('/staff/newsletters/api/ready')).status).toBe(401);
    expect((await request(app()).get('/staff/newsletters/api/ready').set('Cookie', cookie())).body).toEqual({ready: true, stage: 'draft-only', sending: false, customerDispatch: false});
    const broken = new pg.Pool({...connection, port: 1, connectionTimeoutMillis: 100});
    try {
      const a = createNewsletterDraftApp({enabled: true, websiteOrigin: origin, staffSecret: secret, staffDb: pool, newsletterDb: broken});
      const result = await request(a).get(base).set('Cookie', cookie());
      expect(result.status).toBe(503);
      expect(result.body).toEqual({error: 'Newsletter drafts unavailable'});
    } finally { await broken.end(); }
  });
  it('does not mount generic upstream or newsletter sending, imports, login or signup routes', async () => {
    for (const path of ['/v1/send', '/auth/login', '/auth/signup', '/staff/newsletters/api/imports', '/staff/newsletters/api/campaigns/fixture/send', '/newsletters/webhooks/resend'])
      expect((await request(app()).post(path).set('Cookie', cookie()).set('Origin', origin).send({})).status).toBe(404);
  });
});

describe('isolated fixture backup and restore (never a production restore)', () => {
  it('restores drafts, revision history, frozen delivery identity and sticky suppression with sending off', async () => {
    const draft = await store.create(content, 'fixture');
    await store.update(draft.id, 1, {...content, subject: 'Backup synthetic'}, 'fixture');
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"id":"mock-backup-acceptance"}'));
    const ledger = new NewsletterLedger(pool, {mode: 'staff-test', designatedRecipients: ['backup@example.invalid'], apiKey: 'fixture', publicOrigin: origin, webhookSecret: 'whsec_' + Buffer.from('fixture').toString('base64'), eligibility: async () => true, fetch: transport});
    await ledger.importContact({email: 'backup@example.invalid', provenance: [{sourceCategory: 'synthetic', sourceSystem: 'fixture', sourceRecordId: 'backup', observedAt: new Date().toISOString()}], review: false, consentEvidence: 'synthetic test'});
    await ledger.createCampaign('backup-fixture', 'test');
    const delivery = await ledger.enqueue('backup-fixture', 'v1', 'backup@example.invalid', {from: 'Fixture <newsletter@islaelectronics.com>', reply_to: 'reply@islaelectronics.com', ...content});
    await ledger.setCampaignState('backup-fixture', 'running');
    await pool.query("UPDATE isla_newsletter.provider_throttle SET next_at=now()-interval '1 second'");
    expect(await ledger.attempt(delivery)).toBe('accepted');
    await ledger.suppress('backup@example.invalid', 'complaint', 'fixture', 'mock-complaint');
    const tables = ['drafts', 'draft_revisions', 'contacts', 'campaigns', 'deliveries', 'suppressions', 'provider_events', 'provider_throttle'];
    async function snapshot(db: pg.Pool) {
      const state: Record<string, unknown> = {};
      for (const table of tables) state[table] = (await db.query(`SELECT coalesce(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM isla_newsletter.${table} t`)).rows[0].rows;
      return state;
    }
    const before = await snapshot(pool);
    const directory = await mkdtemp(join(socket!, 'newsletter-restore-'));
    const name = 'isla_newsletter_restore_' + randomUUID().replaceAll('-', '');
    const restored = new pg.Pool({...connection, database: name});
    const run = promisify(execFile);
    const env = {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: socket};
    let created = false;
    try {
      await run('/usr/lib/postgresql/17/bin/pg_dump', ['-h', socket!, '-p', '55439', '-U', connection.user, '-d', connection.database, '-Fc', '-n', 'isla_newsletter', '-f', join(directory, 'fixture.dump')], {env});
      await pool.query(`CREATE DATABASE "${name}"`); created = true;
      await run('/usr/lib/postgresql/17/bin/pg_restore', ['-h', socket!, '-p', '55439', '-U', connection.user, '-d', name, '--exit-on-error', '--no-owner', join(directory, 'fixture.dump')], {env});
      expect(await snapshot(restored)).toEqual(before);
      const restoredLedger = new NewsletterLedger(restored, {publicOrigin: origin, webhookSecret: 'whsec_' + Buffer.from('fixture').toString('base64'), eligibility: async () => { throw new Error('Must not dispatch after restore'); }});
      expect(await restoredLedger.attempt(delivery)).toBe('disabled');
      expect(transport).toHaveBeenCalledTimes(1); // Mock only; no live provider call.
      await expect(restored.query("UPDATE isla_newsletter.deliveries SET payload='{}' WHERE id=$1", [delivery])).rejects.toThrow('immutable');
      expect((await restored.query("SELECT count(*)::int AS n FROM isla_newsletter.suppressions WHERE reason='complaint'")).rows[0].n).toBe(1);
      // Schema application is additive/idempotent; previous draft remains readable.
      await restored.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
      expect((await new NewsletterDrafts(restored).get(draft.id))!.revision).toBe(2);
    } finally {
      await restored.end();
      if (created) await pool.query(`DROP DATABASE "${name}"`);
      await rm(directory, {recursive: true, force: true});
    }
  });
});
