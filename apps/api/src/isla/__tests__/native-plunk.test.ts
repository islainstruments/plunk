/* Synthetic local authorization fixtures only; no provider or real recipients. */
import {Controller, Get, Post} from '@overnightjs/core';
import type {Request, Response} from 'express';
import request from 'supertest';
import {describe, expect, it, vi} from 'vitest';

// Unit boundary fixture must not initialize production Prisma/Redis/auth config.
// Real native secret-key authentication is exercised by the isolated controller suite.
vi.mock('../../middleware/auth.js', () => ({
  requireSecretKey: async () => { throw new Error('Invalid fixture key'); },
}));

import {createNativePlunkApp} from '../NativePlunkApp.js';
import type {Staff} from '../StaffBoundary.js';
import {hasVerifiedStaffPlunk} from '../StaffPlunkBoundary.js';

class FixtureTemplates {
  list(_req: Request, res: Response) {
    res.json({verified: hasVerifiedStaffPlunk(res), auth: res.locals.auth});
  }
  create(req: Request, res: Response) { res.status(201).json(req.body); }
}
// Apply legacy decorator functions explicitly: Vite's test transformer does not
// inherit the API workspace's experimentalDecorators tsconfig.
Controller('templates')(FixtureTemplates);
Get('')(FixtureTemplates.prototype, 'list', Object.getOwnPropertyDescriptor(FixtureTemplates.prototype, 'list')!);
Post('')(FixtureTemplates.prototype, 'create', Object.getOwnPropertyDescriptor(FixtureTemplates.prototype, 'create')!);
const origin = 'https://staff.example.invalid';
function app(role: Staff['role'] | null = 'admin', outage = false) {
  return createNativePlunkApp({
    origin, projectId: 'fixed-newsletter-project', controllers: [new FixtureTemplates()],
    lookup: async () => { if (outage) throw new Error('private credential'); return role ? {id: 'fixture-staff', role} : null; },
    project: async () => ({name: 'ISLA Newsletters', tracking: 'DISABLED', secret: 'must-never-serialize', public: 'must-not-serialize'}),
    ready: async () => { if (outage) throw new Error('private credential'); },
  });
}

describe('native Plunk host / website staff boundary', () => {
  it('fails closed for unauthenticated and unavailable staff verification', async () => {
    for (const path of ['/templates', '/users/@me', '/auth/login', '/v1/send']) {
      expect((await request(app(null)).get(path)).status).toBe(401);
      const result = await request(app('admin', true)).get(path);
      expect(result.status).toBe(503);
      expect(result.text).not.toContain('private credential');
    }
  });
  it('binds the configured project, never the client project header or API key', async () => {
    expect((await request(app()).get('/templates').set('Authorization', 'Bearer untrusted')).status).toBe(401);
    const result = await request(app()).get('/templates').set('X-Project-Id', 'other-project');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({verified: true, auth: {type: 'apiKey', projectId: 'fixed-newsletter-project'}});
    expect(result.headers['cache-control']).toBe('private, no-store');
  });
  it('exposes frontend identity/project contracts without native credentials', async () => {
    expect((await request(app()).get('/users/@me')).body).toMatchObject({id: 'fixture-staff', emailVerificationRequired: false});
    const result = await request(app()).get('/users/@me/projects');
    expect(result.body).toEqual([{id: 'fixed-newsletter-project', name: 'ISLA Newsletters', tracking: 'DISABLED', role: 'ADMIN'}]);
    expect(result.text).not.toContain('serialize');
  });
  it('requires admin and exact Origin for drafts and forces marketing after parsing JSON', async () => {
    for (const role of ['viewer', 'support_agent', 'developer'] as const) {
      expect((await request(app(role)).post('/templates').set('Origin', origin).send({name: 'fixture'})).status).toBe(403);
      expect((await request(app(role)).get('/templates')).status).toBe(200);
    }
    for (const untrusted of ['', 'null', 'https://evil.invalid', origin + '.evil.invalid']) {
      expect((await request(app()).post('/templates').set('Origin', untrusted).send({})).status).toBe(403);
    }
    const result = await request(app()).post('/templates').set('Origin', origin).send({type: 'TRANSACTIONAL', name: 'fixture'});
    expect(result.status).toBe(201);
    expect(result.body).toEqual({type: 'MARKETING', name: 'fixture'});
    expect((await request(app()).post('/templates').set('Origin', origin).send([])).status).toBe(400);
  });
  it('keeps alternate auth, imports, subscriptions, API keys and every send action held', async () => {
    for (const path of ['/auth/login', '/auth/signup', '/v1/send', '/emails', '/campaigns/id/send', '/campaigns/id/test', '/campaigns/id/schedule', '/contacts', '/contacts/import', '/contacts/id/subscribe', '/users/@me/projects', '/projects/id', '/workflows']) {
      expect((await request(app()).post(path).set('Origin', origin).send({})).status, path).toBe(423);
    }
    for (const path of ['/contacts/public/id', '/contacts/public/id/unsubscribe', '/auth/login', '/projects/id', '/webhooks/incoming/sns']) {
      expect((await request(app()).get(path)).status, path).toBe(423);
    }
  });
  it('readiness honestly reports holds and redacts dependency failures', async () => {
    expect((await request(app()).get('/health/ready')).body).toEqual({ready: true, application: 'native-plunk', sending: false, imports: false});
    const result = await request(app('admin', true)).get('/health/ready');
    expect(result.status).toBe(503);
    expect(result.text).not.toContain('private credential');
  });
});
