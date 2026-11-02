import {mkdtemp, chmod, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type pg from 'pg';
import request from 'supertest';
import {describe, expect, it, vi} from 'vitest';

import {createRuntimeApp, databaseConfig, readPrivateJson, releaseConfig, runtimeConfig} from '../NewsletterRuntime.js';

const config = runtimeConfig.parse({auth: 'locked', websiteOrigin: 'https://staff.example.invalid', port: 4195, databaseFile: '/private/database.json'});
const revision = 'a'.repeat(40);
const metadata = {revision, source: 'https://github.com/islainstruments/plunk/tree/' + revision};
function fixture(unsafe = false, unavailable = false, ledger = false) {
  const query = vi.fn(async () => {
    if (unavailable) throw new Error('fixture-only private connection detail');
    return {rows: [{unsafe, ledger_write: ledger}]};
  });
  return {app: createRuntimeApp(config, {query} as unknown as pg.Pool, metadata), query};
}
describe('dedicated locked staging runtime', () => {
  it('requires explicit locked auth and rejects extra sending/fixture configuration', () => {
    for (const value of [{...config, auth: 'fixture'}, {...config, auth: 'website'}, {...config, sending: true}, {...config, host: '::'}, {...config, websiteOrigin: 'http://staff.example.invalid'}, {...config, websiteOrigin: 'https://staff.example.invalid/path'}])
      expect(runtimeConfig.safeParse(value).success).toBe(false);
    expect(runtimeConfig.safeParse(config).success).toBe(true);
  });
  it('rejects remote plain DB endpoints, transaction-pool URLs and invalid source metadata', () => {
    const db = {host: 'newsletter-db', port: 5432, database: 'newsletter_staging', user: 'newsletter_runtime', password: 'fixture-only'};
    expect(databaseConfig.safeParse(db).success).toBe(true);
    for (const host of ['db.example.invalid', 'aws.pooler.supabase.com']) expect(databaseConfig.safeParse({...db, host}).success).toBe(false);
    expect(databaseConfig.safeParse({...db, connectionString: 'postgres://fixture.invalid:6543/db'}).success).toBe(false);
    expect(releaseConfig.safeParse({...metadata, revision: 'latest'}).success).toBe(false);
  });
  it('publishes exact revision, AGPL source and honest locked readiness', async () => {
    const {app, query} = fixture();
    expect((await request(app).get('/health/live')).body).toEqual({alive: true, sending: false, revision});
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ready: true, staffAccess: false, sending: false, customerDispatch: false, revision});
    expect(query).toHaveBeenCalledTimes(3);
    const source = await request(app).get('/source');
    expect(source.body).toMatchObject({...metadata, license: 'AGPL-3.0'});
    expect(source.headers.link).toContain(revision);
    expect(source.headers['cache-control']).toBe('private, no-store');
  });
  it('fails readiness closed for DB outage, privileged role or ledger write privilege without leaking details', async () => {
    for (const args of [[true, false, false], [false, true, false], [false, false, true]]) {
      const result = await request(fixture(...args).app).get('/health/ready');
      expect(result.status).toBe(503);
      expect(result.body.ready).toBe(false);
      expect(result.text).not.toContain('private connection detail');
    }
  });
  it('leaves staff editor, assets, draft APIs and every alternate send/auth/import path absent, even with a cookie', async () => {
    const {app, query} = fixture();
    for (const path of ['/staff/newsletters', '/staff/newsletters/editor.js', '/staff/newsletters/editor.css', '/staff/newsletters/api/drafts', '/staff/newsletters/api/ready', '/v1/send', '/emails', '/auth/login', '/auth/signup', '/webhooks/resend', '/api/newsletters/imports']) {
      expect((await request(app).get(path).set('Cookie', 'isla_staff=fixture-invalid')).status).toBe(404);
      expect((await request(app).post(path).send({})).status).toBe(404);
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('requires private config permissions and removes its fixture', async () => {
    if (!process.env.TMPDIR) throw new Error('Scratch required');
    const dir = await mkdtemp(join(process.env.TMPDIR, 'runtime-config-'));
    const file = join(dir, 'fixture.json');
    try {
      await writeFile(file, JSON.stringify(config), {mode: 0o600});
      expect(await readPrivateJson(file)).toEqual(config);
      await chmod(file, 0o644);
      await expect(readPrivateJson(file)).rejects.toThrow('Private regular config');
    } finally { await rm(dir, {recursive: true, force: true}); }
  });
});
