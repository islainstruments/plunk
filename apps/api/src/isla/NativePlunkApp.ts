/* Native Plunk controller host, not the interim draft application. AGPL-3.0. */
import {Server} from '@overnightjs/core';
import cookies from 'cookie-parser';
import express from 'express';
import type {NextFunction, Request, Response} from 'express';

import type {StaffLookup} from './StaffBoundary.js';
import {staffPlunkBoundary} from './StaffPlunkBoundary.js';
import type {NativeNewsletterDelivery} from './NativeNewsletterDelivery.js';
import type {NativeContactImport} from './NativeContactImport.js';

export interface NativePlunkOptions {
  lookup: StaffLookup;
  origin: string;
  projectId: string;
  controllers: object[];
  project: () => Promise<Record<string, unknown> | null>;
  ready: () => Promise<void>;
  delivery?: Pick<NativeNewsletterDelivery, 'analytics' | 'content' | 'saveContent'>;
  contactImport?: NativeContactImport;
}

/** No worker, scheduler, signup, OAuth, SMTP, SES startup or request-body logging. */
export function createNativePlunkApp(options: NativePlunkOptions) {
  const server = new (class extends Server {
    constructor() {
      super();
      this.app.disable('x-powered-by');
      this.app.use(cookies());
      this.app.get('/health/ready', async (_req, res) => {
        try {
          await options.ready();
          res.json({ready: true, application: 'native-plunk', sending: false, imports: false});
        } catch {
          res.status(503).json({ready: false, sending: false, imports: false});
        }
      });
      // Authenticate before parsing potentially large bodies. Every route, including
      // alternate auth and public upstream preference routes, passes the same wall.
      this.app.use(staffPlunkBoundary({...options, contactWrites: !!options.contactImport}));
      this.app.use(express.json({limit: '2mb'}));
      this.app.use((_req, res, next) => {res.locals.nativeContactImport = options.contactImport; next();});
      this.app.use((req, _res, next) => {
        if (!['GET', 'HEAD'].includes(req.method) && /^\/(?:templates|campaigns)(?:\/|$)/.test(req.path)) {
          // Native duplicate/archive/delete actions legitimately have no body.
          req.body ??= {};
          if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return _res.status(400).json({error: {message: 'JSON object required'}});
          }
          req.body.type = 'MARKETING';
        }
        next();
      });
      this.app.get('/users/@me', (_req, res) => res.json({
        id: res.locals.staff.id, type: 'STAFF', emailVerified: true,
        emailVerificationRequired: false,
      }));
      this.app.get('/users/@me/projects', async (_req, res, next) => {
        try {
          const project = await options.project();
          if (!project) return res.status(503).json({error: {message: 'Newsletter project unavailable'}});
          // Never serialize native public/secret API keys or payment identifiers.
          res.json([{
            id: options.projectId, name: project.name, tracking: project.tracking,
            language: project.language, disabled: project.disabled,
            role: res.locals.staff.role === 'admin' ? 'ADMIN' : 'MEMBER',
          }]);
        } catch (error) { next(error); }
      });
      // Native campaign identity + durable provider facts, not upstream SES
      // counters. No dispatch/state/import route is added by this integration.
      this.app.get('/campaigns/:id/delivery', async (req, res, next) => {
        if (!options.delivery) return res.status(503).json({error: {message: 'Delivery ledger not commissioned'}});
        try {res.json(await options.delivery.analytics(req.params.id));}
        catch (error) {next(error);}
      });
      this.app.get('/campaigns/:id/content', async (req, res, next) => {
        if (!options.delivery) return res.sendStatus(503);
        try {res.json(await options.delivery.content(req.params.id));} catch (error) {next(error);}
      });
      this.app.put('/campaigns/:id/content', async (req, res, next) => {
        if (!options.delivery) return res.sendStatus(503);
        if (typeof req.body?.plainText !== 'string' || !Number.isInteger(req.body?.revision)) return res.sendStatus(400);
        try {res.json(await options.delivery.saveContent(req.params.id, req.body.plainText, req.body.revision));} catch (error) {next(error);}
      });
      this.addControllers(options.controllers);
      this.app.use((_req, res) => res.status(404).json({error: {message: 'Unknown native Plunk route'}}));
      this.app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : 500;
        const status = Number.isInteger(code) && code >= 400 && code < 500 ? code : 500;
        // Provider/database errors may contain credentials or recipient content.
        res.status(status).json({error: {message: status === 500 ? 'Newsletter operation unavailable' : 'Newsletter request rejected'}});
      });
    }
  })();
  return server.app;
}
