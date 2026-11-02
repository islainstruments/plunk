/* Explicitly mounted commissioning router, not an unauthenticated Plunk proxy. AGPL-3.0. */
import {Router, json, raw, urlencoded} from 'express';
import type {StaffLookup} from './StaffBoundary.js';
import type {NewsletterLedger} from './NewsletterLedger.js';

export function newsletterRouter(ledger: NewsletterLedger, staff: StaffLookup, websiteOrigin: string): Router {
  const origin = new URL(websiteOrigin).origin;
  const router = Router();
  router.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  router.get('/newsletters/unsubscribe/:token', (req, res) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.token)) {
      res.status(400).type('html').send('<p>Invalid preference link.</p>');
      return;
    }
    // No DB mutation on navigation, preview fetch or scanner GET.
    res
      .type('html')
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Isla email preferences</title><h1>Isla email preferences</h1><p>Stop Isla marketing email. Your account, orders and product access are unchanged.</p><form method="post"><button type="submit">Unsubscribe</button></form></html>',
      );
  });
  router.post('/newsletters/unsubscribe/:token', urlencoded({extended: false, limit: '2kb'}), async (req, res) => {
    await ledger.unsubscribe(req.params.token);
    // RFC8058 receivers need no navigation, HTML, redirect or authentication.
    if (req.body?.['List-Unsubscribe'] === 'One-Click') {
      res.status(200).type('text').send('Marketing preference recorded.');
      return;
    }
    res
      .type('html')
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Isla email preferences</title><p>Marketing preference recorded. Your account, orders and product access are unchanged.</p></html>',
      );
  });
  router.post('/newsletters/webhooks/resend', raw({type: 'application/json', limit: '128kb'}), async (req, res) => {
    const headers: Record<string, string> = {};
    for (const key of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const value = req.headers[key];
      if (typeof value !== 'string') {
        res.sendStatus(400);
        return;
      }
      headers[key] = value;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.sendStatus(400);
      return;
    }
    try {
      const result = await ledger.ingestWebhook(req.body.toString('utf8'), headers);
      res.json({result});
    } catch (error) {
      // Verification/JSON errors are client errors; DB/network failures must be
      // retryable. Do not disclose provider content, secrets or DB details.
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          (error.name.includes('Webhook') ||
            error.message.startsWith('Invalid provider') ||
            error.message.startsWith('Missing event')))
      )
        res.sendStatus(400);
      else res.sendStatus(503);
    }
  });
  router.use('/staff/newsletters/api', async (req, res, next) => {
    try {
      const user = await staff(req);
      if (!user) {
        res.sendStatus(401);
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (user.role !== 'admin') {
          res.sendStatus(403);
          return;
        }
        if (req.headers.origin !== origin) {
          res.sendStatus(403);
          return;
        }
      }
      res.locals.staff = user;
      next();
    } catch {
      res.sendStatus(503);
    }
  });
  router.get('/staff/newsletters/api/status', (_req, res) =>
    res.json({customerDispatch: false, migrationAccepted: false, stage: 'commissioning'}),
  );
  router.get('/staff/newsletters/api/campaigns/:id/analytics', async (req, res) =>
    res.json(await ledger.analytics(req.params.id)),
  );
  router.post('/staff/newsletters/api/campaigns/:id/state', json({limit: '2kb'}), async (req, res) => {
    const state = (req.body as {state?: unknown}).state;
    if (state !== 'draft' && state !== 'paused' && state !== 'running') {
      res.sendStatus(400);
      return;
    }
    await ledger.setCampaignState(req.params.id, state);
    res.json({state});
  });
  // Customer dispatch and migration remain closed even for an authenticated admin.
  router.post('/staff/newsletters/api/imports', (_req, res) => {
    res.status(423).json({error: 'Migration not accepted'});
  });
  router.post('/staff/newsletters/api/campaigns/:id/send', (_req, res) => {
    res.status(423).json({error: 'Customer dispatch not authorized'});
  });
  router.use((_error: unknown, _req: unknown, res: import('express').Response, _next: unknown) => {
    res.sendStatus(503);
  });
  return router;
}
