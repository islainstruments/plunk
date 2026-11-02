/* ISLA draft-only composition. Deliberately does not import upstream app/worker/ledger. AGPL-3.0. */
import express from 'express';
import type {ErrorRequestHandler} from 'express';
import type {Pool} from 'pg';
import sanitizeHtml from 'sanitize-html';
import {z, ZodError} from 'zod';

import {NewsletterDrafts, draftContent} from './NewsletterDrafts.js';
import {editorPolicy, editorStyles, newsletterEditorPage, newsletterEditorScript} from './NewsletterEditor.js';
import {websiteStaffLookup} from './StaffBoundary.js';

export interface DraftAppOptions {
  /** Explicit commissioning opt-in; absent/false leaves all draft routes unavailable. */
  enabled?: boolean;
  websiteOrigin: string;
  staffSecret: string;
  staffDb: Pool;
  newsletterDb: Pool;
  source?: string;
}
const id = z.string().uuid();
const base = '/staff/newsletters/api/drafts';
const edit = z.object({revision: z.number().int().positive().max(2147483646), content: draftContent}).strict();
const previewRevision = z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.number().int().max(2147483647));

/** A separate Express app, NOT middleware that makes upstream Plunk safe to expose. */
export function createNewsletterDraftApp(options: DraftAppOptions) {
  const url = new URL(options.websiteOrigin);
  if (options.source && !/^https:\/\/github\.com\/islainstruments\/plunk\/tree\/[a-f0-9]{40}$/.test(options.source))
    throw new Error('Exact corresponding source required');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Website HTTPS origin required');
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'Link': `<${options.source ?? 'https://github.com/islainstruments/plunk/tree/isla/resend-staff'}>; rel="source"`,
      // Preview is inert even on direct navigation; no remote image/tracking requests.
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    });
    next();
  });
  app.get('/health/live', (_req, res) => res.json({alive: true, sending: false}));
  if (options.enabled === true) {
    const staff = websiteStaffLookup(options.staffDb, options.staffSecret);
    const drafts = new NewsletterDrafts(options.newsletterDb);
    app.use('/staff/newsletters', async (req, res, next) => {
      const user = await staff(req); // Fresh active-role check on every API and preview request.
      if (!user) { res.sendStatus(401); return; }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
          (user.role !== 'admin' || req.headers.origin !== url.origin)) {
        res.sendStatus(403); return;
      }
      res.locals.staff = user;
      next();
    });
    app.get(['/staff/newsletters', '/staff/newsletters/'], (_req, res) => {
      const page = newsletterEditorPage(res.locals.staff);
      res.set('Content-Security-Policy', editorPolicy).type('html').send(options.source ?
        page.replace('https://github.com/islainstruments/plunk/tree/isla/resend-staff', options.source) : page);
    });
    app.get('/staff/newsletters/source', (_req, res) => {
      res.json({source: options.source ?? 'https://github.com/islainstruments/plunk/tree/isla/resend-staff', license: 'AGPL-3.0', sending: false});
    });
    app.get('/staff/newsletters/editor.js', (_req, res) => {
      res.type('application/javascript').send(newsletterEditorScript());
    });
    app.get('/staff/newsletters/editor.css', (_req, res) => {
      res.type('text/css').send(editorStyles);
    });
    app.get('/staff/newsletters/api/ready', async (_req, res) => {
      // No automatic migrations; readiness requires both draft tables and staff DB.
      await options.newsletterDb.query('SELECT id FROM isla_newsletter.drafts LIMIT 0');
      await options.newsletterDb.query('SELECT draft_id FROM isla_newsletter.draft_revisions LIMIT 0');
      res.json({ready: true, stage: 'draft-only', sending: false, customerDispatch: false});
    });
    app.get(base, async (req, res) => {
      const after = req.query.after === undefined ? '' : id.parse(req.query.after);
      const rows = await drafts.list(after);
      const page = rows.slice(0, 20);
      res.json({drafts: page, next: rows.length > 20 ? page[19]!.id : null});
    });
    app.post(base, express.json({limit: '1mb'}), async (req, res) => {
      const saved = await drafts.create(draftContent.parse(req.body), res.locals.staff.id as string);
      res.status(201).location(`${base}/${saved.id}`).json(saved);
    });
    app.get(`${base}/:id`, async (req, res) => {
      const saved = await drafts.get(id.parse(req.params.id));
      if (!saved) { res.sendStatus(404); return; }
      res.json(saved);
    });
    app.put(`${base}/:id`, express.json({limit: '1mb'}), async (req, res) => {
      const draftId = id.parse(req.params.id);
      const body = edit.parse(req.body);
      const saved = await drafts.update(draftId, body.revision, body.content, res.locals.staff.id as string);
      if (!saved) {
        res.status(await drafts.get(draftId) ? 409 : 404).json({error: 'Draft missing or revision changed; reload before saving'});
        return;
      }
      res.json(saved);
    });
    app.get(`${base}/:id/preview`, async (req, res) => {
      const draftId = id.parse(req.params.id);
      const saved = req.query.revision === undefined ? await drafts.get(draftId) :
        await drafts.getRevision(draftId, previewRevision.parse(req.query.revision));
      if (!saved) { res.sendStatus(404); return; }
      if (req.query.format === 'text') { res.type('text/plain').send(saved.content.text); return; }
      if (req.query.format !== undefined && req.query.format !== 'html') { res.sendStatus(400); return; }
      // Original HTML and independent plain text stay intact in draft storage.
      const html = sanitizeHtml(saved.content.html, {
        allowedTags: ['p', 'br', 'div', 'span', 'strong', 'em', 'b', 'i', 'u', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'table', 'tbody', 'tr', 'td', 'th', 'a', 'img'],
        allowedAttributes: {a: ['title'], img: ['src', 'alt', 'width', 'height']},
        allowedSchemes: ['https'],
        allowProtocolRelative: false,
      });
      res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Newsletter preview (not sent)</title><body>${html}</body></html>`);
    });
  }
  // No send/import/auth/webhook/SMTP/queue routes are mounted by this composition.
  app.use((_req, res) => res.sendStatus(404));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = error instanceof ZodError ? 400 :
      (error as {type?: string})?.type === 'entity.too.large' ? 413 :
      (error as {type?: string})?.type === 'entity.parse.failed' ? 400 : 503;
    res.status(status).json({error: status === 503 ? 'Newsletter drafts unavailable' : 'Invalid draft request'});
  };
  app.use(errors);
  return app;
}
