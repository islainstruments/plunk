import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import express from 'express';
import request from 'supertest';
import {Webhook} from 'svix';
import {NewsletterLedger, normalizeEmail, type Options, type DraftPayload} from '../NewsletterLedger.js';
import {websiteStaffLookup} from '../StaffBoundary.js';
import {newsletterRouter} from '../NewsletterRouter.js';

// Deliberately no DATABASE_URL: cannot accidentally use production credentials.
const socket = process.env.TMPDIR;
if (!socket || !/\/isla-(?:infrastructure|software)\/cache\/scratch/.test(socket))
  throw new Error('Private scratch socket required');
const pool = new pg.Pool({host: socket, port: 55439, database: 'isla_newsletter_fixture', max: 8});
const secret = 'whsec_' + Buffer.from('fixture-webhook-secret-not-production').toString('base64');
const authSecret = 'fixture-only-auth-secret-at-least-thirty-two-characters';
const recipient = 'designated@example.invalid';
const draft: DraftPayload = {
  from: 'Fixture <newsletter@islaelectronics.com>',
  reply_to: 'reply@islaelectronics.com',
  subject: 'Fixture newsletter',
  html: '<p>Light mode</p><img src="https://assets.example.invalid/art.png" alt="Artwork">',
  text: 'Hand-written plain text, not regenerated.',
};
let now: Date;
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
let eligibility: ReturnType<typeof vi.fn<(email: string) => Promise<boolean>>>;
let ledger: NewsletterLedger;
function make(extra: Partial<Options> = {}, db = pool) {
  return new NewsletterLedger(db, {
    mode: 'staff-test',
    designatedRecipients: [recipient],
    apiKey: 'fixture-only-not-a-credential',
    publicOrigin: 'https://staff.example.invalid',
    webhookSecret: secret,
    fetch: transport,
    clock: () => now,
    eligibility,
    ...extra,
  });
}
async function seed(
  email = recipient,
  campaign = 'campaign-fixture',
  purpose: 'test' | 'customer' = 'test',
  review = false,
) {
  await ledger.importContact({
    email,
    provenance: [
      {
        sourceCategory: 'fixture-category',
        sourceSystem: 'fixture',
        sourceRecordId: email,
        observedAt: now.toISOString(),
      },
    ],
    priorSends: [{campaignId: 'prior-fixture', reference: 'fixture-reference', state: 'accepted'}],
    review,
    consentEvidence: 'explicit fixture staff test only',
  });
  await ledger.createCampaign(campaign, purpose);
  const id = await ledger.enqueue(campaign, 'v1', email, draft);
  await ledger.setCampaignState(campaign, 'running');
  return id;
}
async function row(id: string) {
  return (await pool.query('SELECT * FROM isla_newsletter.deliveries WHERE id=$1', [id])).rows[0];
}
function signed(
  type: string,
  providerId = 'provider-fixture',
  eventId = 'event-fixture',
  timestamp = new Date(),
  bodyTime = now,
) {
  const raw = JSON.stringify({type, created_at: bodyTime.toISOString(), data: {email_id: providerId}});
  const headers = {
    'svix-id': eventId,
    'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'svix-signature': new Webhook(secret).sign(eventId, timestamp, raw),
  };
  return {raw, headers};
}
function cookie(id = 'admin-fixture', exp = Date.now() + 60000) {
  const encoded = Buffer.from(JSON.stringify({exp, authUserId: id})).toString('base64url');
  return 'isla_staff=' + encoded + '.' + createHmac('sha256', authSecret).update(encoded).digest('hex');
}
function app() {
  const a = express();
  a.use(newsletterRouter(ledger, websiteStaffLookup(pool, authSecret), 'https://staff.example.invalid'));
  return a;
}
beforeAll(async () => {
  const db = (await pool.query('SELECT current_database() AS db')).rows[0].db;
  if (db !== 'isla_newsletter_fixture') throw new Error('Not fixture DB');
  await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await pool.query('CREATE TABLE IF NOT EXISTS public.staff_users(id text PRIMARY KEY,role text,active boolean)');
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE isla_newsletter.provider_events,isla_newsletter.deliveries,isla_newsletter.campaigns,isla_newsletter.suppressions,isla_newsletter.contacts,public.staff_users CASCADE',
  );
  now = new Date(Date.now() + 1000);
  await pool.query('UPDATE isla_newsletter.provider_throttle SET next_at=$1', [new Date(now.getTime() - 1000)]);
  await pool.query(
    "INSERT INTO public.staff_users VALUES('admin-fixture','admin',true),('viewer-fixture','viewer',true),('inactive-fixture','admin',false)",
  );
  transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({id: 'provider-fixture'}), {status: 200}));
  eligibility = vi.fn<(email: string) => Promise<boolean>>().mockResolvedValue(true);
  ledger = make();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('REAL NETWORK FORBIDDEN IN COMMISSIONING TESTS');
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});

describe('durable Resend commissioning ledger (mock provider, real PostgreSQL)', () => {
  it('normalizes address without accepting multi-recipient syntax', () => {
    expect(normalizeEmail(' Fixture@Example.invalid ')).toBe('fixture@example.invalid');
    expect(() => normalizeEmail('a@example.invalid,b@example.invalid')).toThrow();
  });
  it('is disabled by default, including an admin-selected running test', async () => {
    const id = await seed();
    expect(await make({mode: undefined}).attempt(id)).toBe('disabled');
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not send without explicit test recipients', async () => {
    const id = await seed();
    expect(await make({designatedRecipients: []}).attempt(id)).toBe('disabled');
    expect(transport).not.toHaveBeenCalled();
  });
  it('refuses customer dispatch even with a designated recipient', async () => {
    const id = await seed(recipient, 'customer-fixture', 'customer');
    expect(await ledger.attempt(id)).toBe('customer-dispatch-disabled');
    expect(transport).not.toHaveBeenCalled();
  });
  it('refuses a non-designated recipient', async () => {
    const id = await seed('not-designated@example.invalid');
    expect(await ledger.attempt(id)).toBe('recipient-not-designated');
    expect(transport).not.toHaveBeenCalled();
  });
  it('keeps HTML images and original plain text, with private one-click footer in both', async () => {
    const id = await seed();
    await ledger.attempt(id);
    const payload = JSON.parse(transport.mock.calls[0]![1]!.body as string);
    expect(payload.to).toEqual([recipient]);
    expect(payload.cc).toBeUndefined();
    expect(payload.bcc).toBeUndefined();
    expect(payload.html).toContain(draft.html);
    expect(payload.text).toContain(draft.text);
    const url = payload.headers['List-Unsubscribe'].slice(1, -1);
    expect(url).toMatch(/^https:\/\/staff.example.invalid\/newsletters\/unsubscribe\/[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain(recipient);
    expect(payload.html).toContain(url);
    expect(payload.text).toContain(url);
    expect(payload.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
  it('rejects unsafe From/header injection and missing plain text', async () => {
    await seed();
    await expect(
      ledger.enqueue('campaign-fixture', 'v2', recipient, {...draft, from: 'bad@example.invalid'}),
    ).rejects.toThrow();
    await expect(
      ledger.enqueue('campaign-fixture', 'v2', recipient, {...draft, subject: 'x\r\nBcc: bad'}),
    ).rejects.toThrow();
    await expect(ledger.enqueue('campaign-fixture', 'v2', recipient, {...draft, text: ''})).rejects.toThrow();
  });
  it('freezes campaign/version/contact identity, content and token across enqueue retries', async () => {
    const id = await seed();
    const before = await row(id);
    expect(
      await ledger.enqueue('campaign-fixture', 'v1', recipient, {...draft, subject: 'Changed after enqueue'}),
    ).toBe(id);
    expect((await row(id)).payload).toEqual(before.payload);
    await expect(pool.query("UPDATE isla_newsletter.deliveries SET payload='{}' WHERE id=$1", [id])).rejects.toThrow(
      'immutable',
    );
  });
  it('concurrent workers claim one send rather than duplicate delivery', async () => {
    const id = await seed();
    expect(await Promise.all(Array.from({length: 16}, () => ledger.attempt(id)))).toEqual(Array(16).fill('accepted'));
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row(id)).attempts).toBe(1);
  });
  it('retains accepted state through a new pool/client and worker instance', async () => {
    const id = await seed();
    await ledger.attempt(id);
    const fresh = new pg.Pool({host: socket, port: 55439, database: 'isla_newsletter_fixture', max: 2});
    try {
      expect(await make({}, fresh).attempt(id)).toBe('accepted');
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      await fresh.end();
    }
  });
  it('an opted-out queued recipient is skipped before provider dispatch', async () => {
    const id = await seed();
    await ledger.suppress(recipient, 'unsubscribe', 'fixture', 'withdrawal-fixture');
    expect(await ledger.attempt(id)).toBe('skipped');
    expect(transport).not.toHaveBeenCalled();
  });
  it('reimport preserves suppression, provenance, history and review flags', async () => {
    await seed(recipient, 'campaign-fixture', 'test', true);
    await ledger.suppress(recipient, 'withdrawal', 'fixture', 'withdrawal-fixture');
    await ledger.importContact({
      email: recipient,
      provenance: [
        {
          sourceCategory: 'second-fixture',
          sourceSystem: 'fixture',
          sourceRecordId: 'other-fixture',
          observedAt: now.toISOString(),
        },
      ],
      priorSends: [{campaignId: 'other', reference: 'second', state: 'uncertain'}],
      review: false,
      consentEvidence: 'must not replace',
    });
    const contact = (await pool.query('SELECT * FROM isla_newsletter.contacts')).rows[0];
    expect(contact.review).toBe(true);
    expect(contact.provenance).toHaveLength(2);
    expect(contact.prior_sends).toHaveLength(2);
    expect(contact.consent_evidence).toBe('explicit fixture staff test only');
    expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(1);
  });
  it('checks fresh canonical eligibility before sending and fails closed on lookup errors', async () => {
    const id = await seed();
    eligibility.mockRejectedValueOnce(new Error('canonical unavailable'));
    await expect(ledger.attempt(id)).rejects.toThrow('canonical unavailable');
    expect(transport).not.toHaveBeenCalled();
    eligibility.mockResolvedValueOnce(false);
    expect(await ledger.attempt(id)).toBe('skipped');
  });
  it('pause preserves queued work and resume sends it once', async () => {
    const id = await seed();
    await ledger.setCampaignState('campaign-fixture', 'paused');
    expect(await ledger.attempt(id)).toBe('paused');
    expect(transport).not.toHaveBeenCalled();
    await ledger.setCampaignState('campaign-fixture', 'running');
    expect(await ledger.attempt(id)).toBe('accepted');
  });
  it('shares a durable throttle across worker instances', async () => {
    const id = await seed();
    await ledger.attempt(id);
    const id2 = await ledger.enqueue('campaign-fixture', 'v2', recipient, draft);
    expect(await make().attempt(id2)).toBe('throttled');
    now = new Date(now.getTime() + 1001);
    transport.mockResolvedValueOnce(new Response(JSON.stringify({id: 'provider-second'})));
    expect(await make().attempt(id2)).toBe('accepted');
  });
  it('retries uncertain acceptance with exactly the same key and payload', async () => {
    const id = await seed();
    transport.mockRejectedValueOnce(new Error('response lost after mock acceptance'));
    expect(await ledger.attempt(id)).toBe('uncertain');
    expect((await row(id)).first_attempt_at).not.toBeNull();
    now = new Date(now.getTime() + 61000);
    expect(await make().attempt(id)).toBe('accepted');
    expect(transport.mock.calls[1]![1]!.body).toBe(transport.mock.calls[0]![1]!.body);
    expect(transport.mock.calls[1]![1]!.headers).toEqual(transport.mock.calls[0]![1]!.headers);
  });
  it('quarantines expired uncertain attempts, without rotating key or resending', async () => {
    const id = await seed();
    transport.mockRejectedValueOnce(new Error('lost'));
    await ledger.attempt(id);
    const old = await row(id);
    now = new Date(now.getTime() + 23 * 3600000);
    expect(await ledger.attempt(id)).toBe('review');
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row(id)).idempotency_key).toBe(old.idempotency_key);
  });
  it('honors Retry-After without treating provider rejection as delivery', async () => {
    const id = await seed();
    transport.mockResolvedValueOnce(new Response('{}', {status: 429, headers: {'retry-after': '120'}}));
    expect(await ledger.attempt(id)).toBe('retry');
    expect(await ledger.attempt(id)).toBe('deferred');
    expect((await ledger.analytics('campaign-fixture')).accepted).toBe(0);
  });
  it('routes permanent provider errors to review rather than an automatic new request', async () => {
    const id = await seed();
    transport.mockResolvedValueOnce(new Response('{}', {status: 422}));
    expect(await ledger.attempt(id)).toBe('review');
    expect(await ledger.attempt(id)).toBe('review');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('requires a valid provider id; malformed acceptance is uncertain', async () => {
    const id = await seed();
    transport.mockResolvedValueOnce(new Response('{"unexpected":true}'));
    expect(await ledger.attempt(id)).toBe('uncertain');
    expect((await row(id)).provider_id).toBeNull();
  });
  it('survives a real worker SIGKILL after mock provider acceptance', async () => {
    const id = await seed();
    const code = `import pg from 'pg'; import {NewsletterLedger} from './apps/api/src/isla/NewsletterLedger.ts';
      const pool=new pg.Pool({host:process.env.TMPDIR,port:55439,database:'isla_newsletter_fixture'});
      const ledger=new NewsletterLedger(pool,{mode:'staff-test',designatedRecipients:['${recipient}'],apiKey:'fixture-only',publicOrigin:'https://staff.example.invalid',webhookSecret:'${secret}',eligibility:async()=>true,fetch:async()=>{process.stdout.write('MOCK_ACCEPTED\\n');await new Promise(()=>{});}});
      await ledger.attempt('${id}');`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: {...process.env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker did not reach mock acceptance')), 8000);
        child.stdout.on('data', b => {
          if (String(b).includes('MOCK_ACCEPTED')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('exit', c => {
          clearTimeout(timer);
          reject(new Error('worker exited ' + c));
        });
      });
      const before = await row(id);
      expect(before.first_attempt_at).not.toBeNull();
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      now = new Date(Date.now() + 61000);
      expect(await ledger.attempt(id)).toBe('accepted');
      expect((transport.mock.calls[0]![1]!.headers as Record<string, string>)['Idempotency-Key']).toBe(
        before.idempotency_key,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});

describe('verified events and public preference routes (signed synthetic fixtures)', () => {
  it.each(['Permanent', 'Temporary', 'Unknown', null])('classifies %s bounce conservatively', async type => {
    await seed().then(id => ledger.attempt(id));
    const at = new Date();
    const raw = JSON.stringify({type: 'email.bounced', created_at: at.toISOString(),
      data: {email_id: 'provider-fixture', bounce: {type}}});
    const headers = {'svix-id': 'bounce-policy', 'svix-timestamp': String(Math.floor(at.getTime() / 1000)),
      'svix-signature': new Webhook(secret).sign('bounce-policy', at, raw)};
    await ledger.ingestWebhook(raw, headers);
    expect((await pool.query('SELECT reason FROM isla_newsletter.suppressions')).rows[0].reason)
      .toBe(type === 'Permanent' ? 'hard_bounce' : 'quarantine');
  });
  it('restart reconciliation repairs persisted events without a provider replay', async () => {
    await seed().then(id => ledger.attempt(id));
    const e = signed('email.complained');
    await ledger.ingestWebhook(e.raw, e.headers);
    await pool.query('DELETE FROM isla_newsletter.suppressions');
    expect(await make().reconcileProviderEvents()).toBe(1);
    expect(await make().reconcileProviderEvents()).toBe(0);
    expect((await pool.query('SELECT reason FROM isla_newsletter.suppressions')).rows[0].reason).toBe('complaint');
  });
  it('conflicting signed replay cannot retarget a persisted provider event', async () => {
    await seed().then(id => ledger.attempt(id));
    const original = signed('email.delivered', 'unrelated-provider');
    await ledger.ingestWebhook(original.raw, original.headers);
    const conflict = signed('email.complained');
    expect(await ledger.ingestWebhook(conflict.raw, conflict.headers)).toBe('duplicate');
    expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(0);
    expect((await ledger.analytics('campaign-fixture')).providerEvents).toEqual([]);
  });
  it.each(['email.failed', 'email.delivery_delayed'])('records %s without inventing a hard bounce', async type => {
    await seed().then(id => ledger.attempt(id));
    const e = signed(type);
    await ledger.ingestWebhook(e.raw, e.headers);
    expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(0);
    expect((await ledger.analytics('campaign-fixture')).providerEvents)
      .toEqual([{event_type: type, total_events: 1, unique_messages: 1}]);
  });
  it('rechecks canonical veto after reserving the provider slot', async () => {
    const id = await seed();
    eligibility.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await ledger.attempt(id)).toBe('skipped');
    expect(transport).not.toHaveBeenCalled();
    expect((await row(id)).attempts).toBe(0);
  });
  it('429 backoff also throttles other deliveries after worker restart', async () => {
    const id = await seed();
    transport.mockResolvedValueOnce(new Response('{}', {status: 429, headers: {'retry-after': '120'}}));
    expect(await ledger.attempt(id)).toBe('retry');
    now = new Date(now.getTime() + 61000);
    const second = await ledger.enqueue('campaign-fixture', 'v2', recipient, draft);
    expect(await make().attempt(second)).toBe('throttled');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('accepts a valid signed event and deduplicates replays', async () => {
    await seed().then(id => ledger.attempt(id));
    const e = signed('email.delivered');
    expect(await ledger.ingestWebhook(e.raw, e.headers)).toBe('recorded');
    expect(await ledger.ingestWebhook(e.raw, e.headers)).toBe('duplicate');
    expect((await ledger.analytics('campaign-fixture')).providerEvents).toEqual([
      {event_type: 'email.delivered', total_events: 1, unique_messages: 1},
    ]);
  });
  it('rejects tampered body/signature and stale timestamp before DB write', async () => {
    const e = signed('email.delivered');
    await expect(ledger.ingestWebhook(e.raw + ' ', e.headers)).rejects.toThrow();
    const stale = signed('email.bounced', 'provider-fixture', 'stale-event', new Date(Date.now() - 600000));
    await expect(ledger.ingestWebhook(stale.raw, stale.headers)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM isla_newsletter.provider_events')).rowCount).toBe(0);
  });
  it.each(['email.bounced', 'email.complained', 'email.suppressed'])(
    'persists sticky suppression for %s despite out-of-order delivery',
    async type => {
      const id = await seed();
      await ledger.attempt(id);
      let e = signed(type);
      await ledger.ingestWebhook(e.raw, e.headers);
      e = signed('email.delivered', 'provider-fixture', 'later-delivery');
      await ledger.ingestWebhook(e.raw, e.headers);
      expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(1);
      const second = await ledger.enqueue('campaign-fixture', 'v2', recipient, draft);
      expect(await ledger.attempt(second)).toBe('skipped');
    },
  );
  it('reconciles an event received before the provider response is persisted', async () => {
    const id = await seed();
    const e = signed('email.complained');
    await ledger.ingestWebhook(e.raw, e.headers);
    expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(0);
    await ledger.attempt(id);
    expect((await pool.query('SELECT reason FROM isla_newsletter.suppressions')).rows[0].reason).toBe('complaint');
  });
  it('a duplicate event repairs suppression side effects after an interrupted handler', async () => {
    const id = await seed();
    await ledger.attempt(id);
    const e = signed('email.bounced');
    await ledger.ingestWebhook(e.raw, e.headers);
    await pool.query('DELETE FROM isla_newsletter.suppressions');
    expect(await ledger.ingestWebhook(e.raw, e.headers)).toBe('duplicate');
    expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(1);
  });
  it('does not suppress unknown transactional recipients from provider event payloads', async () => {
    const e = signed('email.bounced', 'transactional-unknown');
    await ledger.ingestWebhook(e.raw, e.headers);
    expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(0);
  });
  it('does not count acceptance as delivery, shows unique vs provider total events', async () => {
    const id = await seed();
    await ledger.attempt(id);
    let analytics = await ledger.analytics('campaign-fixture');
    expect(analytics.accepted).toBe(1);
    expect(analytics.providerEvents).toEqual([]);
    for (const eventId of ['open1', 'open2']) {
      const e = signed('email.opened', 'provider-fixture', eventId);
      await ledger.ingestWebhook(e.raw, e.headers);
    }
    analytics = await ledger.analytics('campaign-fixture');
    expect(analytics.providerEvents).toEqual([{event_type: 'email.opened', total_events: 2, unique_messages: 1}]);
    expect(analytics.caveat).toContain('proxy/scanner');
    expect(analytics.trackingCapability).toBe('not commissioned');
  });
  it('footer GET/scanner navigation does not mutate; RFC8058 POST works without login', async () => {
    const id = await seed();
    const payload = (await row(id)).payload;
    const url = new URL(payload.headers['List-Unsubscribe'].slice(1, -1));
    const get = await request(app()).get(url.pathname);
    expect(get.status).toBe(200);
    expect(get.text).toContain('<form method="post">');
    expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(0);
    const post = await request(app()).post(url.pathname).type('form').send('List-Unsubscribe=One-Click');
    expect(post.status).toBe(200);
    expect(post.headers['content-type']).toContain('text/plain');
    expect(post.headers.location).toBeUndefined();
    expect(await ledger.attempt(id)).toBe('skipped');
    expect((await ledger.analytics('campaign-fixture')).unsubscribed).toBe(1);
    expect((await request(app()).post(url.pathname)).status).toBe(200);
    expect((await pool.query('SELECT * FROM isla_newsletter.suppressions')).rowCount).toBe(1);
  });
  it('unknown token POST does not reveal existence and unsafe GET is rejected', async () => {
    expect((await request(app()).post('/newsletters/unsubscribe/' + 'x'.repeat(43))).status).toBe(200);
    expect((await request(app()).get('/newsletters/unsubscribe/invalid')).status).toBe(400);
  });
  it('webhook HTTP endpoint verifies raw bytes and rejects a mutated payload', async () => {
    const e = signed('email.delivered');
    expect(
      (
        await request(app())
          .post('/newsletters/webhooks/resend')
          .set(e.headers)
          .set('Content-Type', 'application/json')
          .send(e.raw)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app())
          .post('/newsletters/webhooks/resend')
          .set(e.headers)
          .set('Content-Type', 'application/json')
          .send(e.raw + ' ')
      ).status,
    ).toBe(400);
  });
});

describe('website staff authorization boundary', () => {
  it('denies anonymous, foreign-token and inactive-staff requests', async () => {
    for (const value of ['', 'next_token=foreign', cookie('inactive-fixture')])
      expect((await request(app()).get('/staff/newsletters/api/status').set('Cookie', value)).status).toBe(401);
  });
  it('denies expired or altered signed website sessions', async () => {
    expect(
      (
        await request(app())
          .get('/staff/newsletters/api/status')
          .set('Cookie', cookie('admin-fixture', Date.now() - 1000))
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app())
          .get('/staff/newsletters/api/status')
          .set('Cookie', cookie() + 'a')
      ).status,
    ).toBe(401);
  });
  it('permits active staff reads but blocks viewer writes and admin cross-origin writes', async () => {
    await seed();
    expect(
      (await request(app()).get('/staff/newsletters/api/status').set('Cookie', cookie('viewer-fixture'))).status,
    ).toBe(200);
    const path = '/staff/newsletters/api/campaigns/campaign-fixture/state';
    expect(
      (
        await request(app())
          .post(path)
          .set('Cookie', cookie('viewer-fixture'))
          .set('Origin', 'https://staff.example.invalid')
          .send({state: 'paused'})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .post(path)
          .set('Cookie', cookie())
          .set('Origin', 'https://attacker.example.invalid')
          .send({state: 'paused'})
      ).status,
    ).toBe(403);
    expect((await request(app()).post(path).set('Cookie', cookie()).send({state: 'paused'})).status).toBe(403);
    expect(
      (
        await request(app())
          .post(path)
          .set('Cookie', cookie())
          .set('Origin', 'https://staff.example.invalid')
          .send({state: 'paused'})
      ).status,
    ).toBe(200);
  });
  it('rechecks active staff status for every request rather than trusting the token role', async () => {
    const session = cookie();
    expect((await request(app()).get('/staff/newsletters/api/status').set('Cookie', session)).status).toBe(200);
    await pool.query("UPDATE public.staff_users SET active=false WHERE id='admin-fixture'");
    expect((await request(app()).get('/staff/newsletters/api/status').set('Cookie', session)).status).toBe(401);
  });
  it('locks migration and customer dispatch even for a valid admin', async () => {
    for (const path of ['/staff/newsletters/api/imports', '/staff/newsletters/api/campaigns/campaign-fixture/send'])
      expect(
        (await request(app()).post(path).set('Cookie', cookie()).set('Origin', 'https://staff.example.invalid')).status,
      ).toBe(423);
  });
});
