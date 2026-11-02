/* Real compiled-service browser commissioning, synthetic identities only. AGPL-3.0.
 * Build first. PLAYWRIGHT_MODULE points to an installed playwright package;
 * optional CHROMIUM_EXECUTABLE selects an already installed browser.
 * Never reads DATABASE_URL. Own loopback HTTPS server and random fixture DB are removed.
 */
/* global window, document, innerWidth */
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import console from 'node:console';
import {createHmac, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import https from 'node:https';
import {userInfo} from 'node:os';
import {dirname, join} from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL, URL} from 'node:url';

import pg from 'pg';

const directoryOfTest = dirname(fileURLToPath(import.meta.url));

async function main() {
  const scratch = process.env.TMPDIR;
  assert(scratch && scratch.includes('/isla-infrastructure/cache/scratch'), 'Private fixture socket required');
  const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
  const connection = {host: scratch, port: 55439, user: userInfo().username, password: '', database: 'isla_newsletter_fixture'};
  const control = new pg.Pool(connection);
  const name = 'isla_editor_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({...connection, database: name});
  const directory = await mkdtemp(join(scratch, 'editor-browser-'));
  const secret = 'synthetic-browser-fixture-auth-secret-not-production';
  let server, browser, created = false;
  const passed = [];
  const check = label => { passed.push(label); console.log('PASS ' + label); };
  try {
    assert.equal((await control.query('SELECT current_database() AS db')).rows[0].db, connection.database);
    await control.query(`CREATE DATABASE "${name}"`); created = true;
    await pool.query(await readFile(join(directoryOfTest, '../schema.sql'), 'utf8'));
    await pool.query('CREATE TABLE public.staff_users(id text PRIMARY KEY,role text,active boolean)');
    await pool.query("INSERT INTO public.staff_users VALUES('editor-admin','admin',true),('editor-viewer','viewer',true),('editor-support','support_agent',true),('editor-developer','developer',true),('editor-inactive','admin',false)");
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'fixture.key'), '-out', join(directory, 'fixture.crt'), '-days', '1', '-subj', '/CN=localhost'], {stdio: 'ignore'});
    const {createNewsletterDraftApp} = await import(pathToFileURL(join(directoryOfTest, '../../../dist/isla/NewsletterDraftApp.js')).href);
    let app;
    server = https.createServer({key: await readFile(join(directory, 'fixture.key')), cert: await readFile(join(directory, 'fixture.crt'))}, (req, res) => app(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${server.address().port}`;
    app = createNewsletterDraftApp({enabled: true, websiteOrigin: origin, staffSecret: secret, staffDb: pool, newsletterDb: pool});
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {})});
    console.log('Compiled service on loopback HTTPS; Chromium ' + browser.version());
    const errors = [], external = [];
    async function context(user, expired = false) {
      const ctx = await browser.newContext({ignoreHTTPSErrors: true});
      await ctx.route('**/*', route => {
        if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      if (user) {
        const encoded = Buffer.from(JSON.stringify({authUserId: user, exp: Date.now() + (expired ? -1000 : 600000)})).toString('base64url');
        await ctx.addCookies([{name: 'isla_staff', value: `${encoded}.${createHmac('sha256', secret).update(encoded).digest('hex')}`, url: origin, httpOnly: true, secure: true, sameSite: 'Lax'}]);
      }
      return ctx;
    }
    const route = '/staff/newsletters';
    const base = route + '/api/drafts';
    async function status(page, value) { await page.getByRole('status').filter({hasText: value}).waitFor(); }
    async function fill(page, content) {
      await page.getByLabel('Subject', {exact: true}).fill(content.subject);
      await page.getByLabel('HTML source').fill(content.html);
      await page.getByLabel('Independent plain text').fill(content.text);
    }
    for (const [user, expired] of [[null, false], ['editor-inactive', false], ['editor-admin', true]]) {
      const ctx = await context(user, expired);
      for (const path of [route, route + '/editor.js', route + '/editor.css', base]) assert.equal((await ctx.request.get(origin + path)).status(), 401);
      await ctx.close();
    }
    check('anonymous, inactive and expired sessions denied page/assets/API');
    const admin = await context('editor-admin');
    const page = await admin.newPage();
    await page.goto(origin + route);
    await status(page, 'Select a draft');
    const original = {subject: 'Synthetic browser draft', html: '<h1>Fixture news</h1><p>Rich <strong>HTML</strong></p><img src="https://assets.example.invalid/art.png" alt="Synthetic artwork" onerror="window.hostile=1"><script>window.hostile=2</script><a href="javascript:alert(1)">Blocked</a>', text: 'Independent text, not derived from HTML.\n  Keep spacing & symbols < >.\nSecond paragraph.'};
    await page.getByRole('button', {name: 'New draft', exact: true}).click();
    await fill(page, original);
    await page.getByRole('button', {name: 'Save draft', exact: true}).click();
    await status(page, 'Saved revision 1');
    const draftId = new URL(page.url()).searchParams.get('draft');
    assert.match(draftId, /^[0-9a-f-]{36}$/);
    assert.deepEqual((await (await admin.request.get(origin + base + '/' + draftId)).json()).content, original);
    await page.reload(); await status(page, 'Loaded revision 1');
    assert.equal(await page.getByLabel('Independent plain text').inputValue(), original.text);
    assert.equal(await page.getByLabel('HTML source').inputValue(), original.html);
    check('admin creates, persists and reloads independent HTML/plain text through real browser');
    const frame = page.frameLocator('#html-preview');
    await frame.getByRole('heading', {name: 'Fixture news'}).waitFor();
    assert.equal(await frame.locator('img').getAttribute('alt'), 'Synthetic artwork');
    assert.equal(await frame.locator('img').getAttribute('src'), 'https://assets.example.invalid/art.png');
    assert.equal(await frame.locator('script,[onerror],a[href]').count(), 0);
    assert.equal(await page.locator('#text-preview').textContent(), original.text);
    assert.equal(await page.evaluate(() => window.hostile), undefined);
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), '');
    const preview = await admin.request.get(origin + base + '/' + draftId + '/preview');
    assert.match(preview.headers()['content-security-policy'], /sandbox; default-src 'none'/);
    assert.match((await admin.request.get(origin + route)).headers()['content-security-policy'], /script-src 'self'/);
    assert.equal(external.length, 0);
    check('sandboxed saved preview preserves image markup, strips executable HTML, blocks remote assets');
    const second = await admin.newPage();
    await second.goto(page.url()); await status(second, 'Loaded revision 1');
    await page.getByLabel('Subject', {exact: true}).fill('First editor wins');
    await page.getByRole('button', {name: 'Save draft', exact: true}).click(); await status(page, 'Saved revision 2');
    const localText = 'Conflict local text must survive.\nSecond line.';
    await second.getByLabel('Subject', {exact: true}).fill('Stale local subject');
    await second.getByLabel('Independent plain text').fill(localText);
    await second.getByRole('button', {name: 'Save draft', exact: true}).click(); await status(second, 'Conflict:');
    assert.equal(await second.getByLabel('Independent plain text').inputValue(), localText);
    assert.equal(await second.locator('#conflict').isVisible(), true);
    assert.match(await second.locator('#latest').textContent(), /First editor wins/);
    assert.equal((await (await admin.request.get(origin + base + '/' + draftId)).json()).revision, 2);
    second.once('dialog', dialog => dialog.accept());
    await second.getByRole('button', {name: 'Load latest and discard local changes'}).click();
    await status(second, 'Latest saved revision loaded');
    assert.equal(await second.getByLabel('Subject', {exact: true}).inputValue(), 'First editor wins');
    assert.equal(await second.getByLabel('Independent plain text').inputValue(), original.text);
    await second.getByLabel('Independent plain text').fill('Reconciled explicit plain text.');
    await second.getByRole('button', {name: 'Save draft', exact: true}).click(); await status(second, 'Saved revision 3');
    const revisions = await pool.query('SELECT revision FROM isla_newsletter.draft_revisions WHERE draft_id=$1 ORDER BY revision', [draftId]);
    assert.deepEqual(revisions.rows.map(r => r.revision), [1, 2, 3]);
    check('two-browser-tab conflict retains local changes, explicit reconciliation saves audited revision 3');
    await second.getByRole('button', {name: 'Copy to new draft'}).click();
    await second.getByLabel('Subject', {exact: true}).fill('Reusable copied draft');
    await second.getByRole('button', {name: 'Save draft', exact: true}).click(); await status(second, 'Saved revision 1');
    assert.notEqual(new URL(second.url()).searchParams.get('draft'), draftId);
    assert.equal((await (await admin.request.get(origin + base + '/' + draftId)).json()).revision, 3);
    check('copy-to-new reuses content without modifying original draft');
    for (const user of ['editor-viewer', 'editor-support', 'editor-developer']) {
      const ctx = await context(user), p = await ctx.newPage();
      await p.goto(origin + route + '?draft=' + draftId); await status(p, 'Loaded revision 3');
      assert.equal(await p.getByRole('button', {name: 'Save draft', exact: true}).isVisible(), false);
      assert.equal(await p.getByRole('button', {name: 'New draft', exact: true}).isVisible(), false);
      assert.equal(await p.getByLabel('HTML source').isDisabled(), true);
      await p.frameLocator('#html-preview').getByRole('heading', {name: 'Fixture news'}).waitFor();
      assert.equal((await ctx.request.post(origin + base, {headers: {Origin: origin}, data: original})).status(), 403);
      assert.equal((await ctx.request.put(origin + base + '/' + draftId, {headers: {Origin: origin}, data: {revision: 3, content: original}})).status(), 403);
      await ctx.close();
    }
    check('viewer/support/developer can read and preview; UI and backend prohibit create/edit');
    for (const foreign of ['https://attacker.example.invalid', 'null']) assert.equal((await admin.request.post(origin + base, {headers: {Origin: foreign}, data: original})).status(), 403);
    await pool.query("UPDATE public.staff_users SET role='viewer' WHERE id='editor-admin'");
    await page.getByLabel('Subject', {exact: true}).fill('Revoked write');
    await page.getByRole('button', {name: 'Save draft', exact: true}).click(); await status(page, 'Write denied');
    assert.equal(await page.getByLabel('Subject', {exact: true}).inputValue(), 'Revoked write');
    await pool.query("UPDATE public.staff_users SET active=false WHERE id='editor-admin'");
    assert.equal((await admin.request.get(origin + route)).status(), 401);
    await pool.query("UPDATE public.staff_users SET active=true,role='admin' WHERE id='editor-admin'");
    check('exact-Origin protection and live role/session revocation enforce backend boundary');
    for (const path of ['/v1/send', '/auth/login', '/auth/signup', route + '/api/imports', route + '/api/send', route + '/api/campaigns/fixture/send']) assert.equal((await admin.request.post(origin + path, {headers: {Origin: origin}, data: {}})).status(), 404);
    assert.equal((await admin.request.get(origin + '/')).status(), 404);
    assert.equal((await admin.request.get(origin + '/projects')).status(), 404);
    assert.equal((await (await admin.request.get(origin + '/health/live')).json()).sending, false);
    for (const table of ['contacts', 'campaigns', 'deliveries']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM isla_newsletter.${table}`)).rows[0].n, 0);
    assert.equal(external.length, 0); assert.deepEqual(errors, []);
    check('no upstream UI, alternate auth, import or dispatch route; no contacts/campaigns/deliveries or external requests');
    const fresh = await admin.newPage(); await fresh.goto(origin + route); await status(fresh, 'Select a draft');
    await fresh.getByRole('button', {name: 'First editor wins · r3', exact: true}).click(); await status(fresh, 'Loaded revision 3');
    assert.equal(await fresh.getByLabel('Independent plain text').inputValue(), 'Reconciled explicit plain text.');
    assert.equal(await fresh.getByRole('link', {name: 'Complete corresponding source and build instructions'}).getAttribute('href'), 'https://github.com/islainstruments/plunk/tree/isla/resend-staff');
    await fresh.setViewportSize({width: 390, height: 844});
    assert.equal(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await fresh.screenshot({path: join(directory, 'synthetic-editor.png'), fullPage: true});
    check('saved draft list opens persisted revision; mobile layout fits and corresponding source is accessible');
    await fresh.getByRole('button', {name: 'New draft', exact: true}).click();
    await fill(fresh, {...original, subject: 'Validation and recovery', text: ''});
    await fresh.getByRole('button', {name: 'Save draft', exact: true}).click();
    assert.equal(await fresh.locator('form').evaluate(form => form.checkValidity()), false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM isla_newsletter.drafts')).rows[0].n, 2);
    await fresh.getByLabel('Independent plain text').fill(' ');
    await fresh.getByRole('button', {name: 'Save draft', exact: true}).click(); await status(fresh, 'Request failed (400)');
    assert.equal(await fresh.getByLabel('HTML source').inputValue(), original.html);
    await fresh.getByLabel('Independent plain text').fill('Recovered independent text.');
    await fresh.route('**/api/drafts', request => request.fulfill({status: 503, contentType: 'application/json', body: '{"error":"Synthetic outage"}'}));
    await fresh.getByRole('button', {name: 'Save draft', exact: true}).click(); await status(fresh, 'Request failed (503)');
    assert.equal(await fresh.getByLabel('Independent plain text').inputValue(), 'Recovered independent text.');
    await fresh.unroute('**/api/drafts');
    await fresh.getByRole('button', {name: 'Save draft', exact: true}).click(); await status(fresh, 'Saved revision 1');
    await fresh.getByLabel('Subject', {exact: true}).fill('Unsaved changes retained');
    fresh.once('dialog', dialog => dialog.dismiss());
    await fresh.getByRole('button', {name: 'Reload saved revision', exact: true}).click();
    assert.equal(await fresh.getByLabel('Subject', {exact: true}).inputValue(), 'Unsaved changes retained');
    fresh.once('dialog', dialog => dialog.accept());
    await fresh.getByRole('button', {name: 'Reload saved revision', exact: true}).click(); await status(fresh, 'Loaded revision 1');
    assert.equal(await fresh.getByLabel('Subject', {exact: true}).inputValue(), 'Validation and recovery');
    check('invalid input and synthetic 503 retain local work; retry succeeds; discard cancellation preserves edits');
    for (let i = 0; i < 21; i++) {
      const response = await admin.request.post(origin + base, {headers: {Origin: origin}, data: {...original, subject: i === 0 ? '<img src=x onerror=alert(1)> literal subject' : `Pagination fixture ${i}`}});
      assert.equal(response.status(), 201);
    }
    await fresh.getByRole('button', {name: 'Refresh list', exact: true}).click(); await status(fresh, 'Draft list refreshed');
    assert.equal(await fresh.locator('#drafts li').count(), 20);
    await fresh.getByRole('button', {name: 'Load more', exact: true}).click();
    await fresh.locator('#drafts li').nth(23).waitFor();
    assert.equal(await fresh.locator('#drafts li').count(), 24);
    assert.equal(await fresh.getByRole('button', {name: 'Load more', exact: true}).isVisible(), false);
    assert.equal(new Set(await fresh.locator('#drafts li').allTextContents()).size, 24);
    assert.equal(await fresh.locator('#drafts img, #drafts script').count(), 0);
    assert.equal(await fresh.getByLabel('Subject', {exact: true}).inputValue(), 'Validation and recovery');
    assert.deepEqual(errors, []); assert.equal(external.length, 0);
    check('browser paginates 24 drafts without duplicates or editor reset; hostile subject renders only as text');
    app = createNewsletterDraftApp({websiteOrigin: origin, staffSecret: secret, staffDb: pool, newsletterDb: pool});
    for (const path of [route, route + '/editor.js', base]) assert.equal((await admin.request.get(origin + path)).status(), 404);
    assert.equal((await (await admin.request.get(origin + '/health/live')).json()).sending, false);
    check('constructor default-off removes editor/assets/API while keeping liveness non-sending');
    console.log(`Browser commissioning: ${passed.length}/${passed.length} checks passed; page errors=0, external requests=0. No email sent.`);
  } finally {
    if (browser) { await browser.close(); assert.equal(browser.isConnected(), false); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(server.listening, false); }
    await pool.end();
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
    await rm(directory, {recursive: true, force: true});
    console.log('Cleanup: owned browser/server closed; generated fixture database and TLS/screenshot directory removed.');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
