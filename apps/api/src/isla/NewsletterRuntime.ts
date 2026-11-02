/* ISLA isolated non-sending runtime. AGPL-3.0. No upstream app/ledger/worker imports. */
import {readFile, stat} from 'node:fs/promises';
import type {Server} from 'node:http';

import express from 'express';
import pg from 'pg';
import {z} from 'zod';

import {createNewsletterDraftApp} from './NewsletterDraftApp.js';

export const runtimeConfig = z.object({
  // This release cannot activate staff auth. A separate scoped binding is required.
  auth: z.literal('locked'),
  websiteOrigin: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
  }),
  host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  port: z.number().int().min(1024).max(65535),
  databaseFile: z.string().startsWith('/'),
}).strict();
export const databaseConfig = z.object({
  // Local Unix socket, loopback or isolated Docker alias only. No remote TLS downgrade.
  host: z.string().refine(value => value === 'newsletter-db' || value === '127.0.0.1' || value.startsWith('/')),
  port: z.number().int().min(1).max(65535),
  database: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  user: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  password: z.string(),
}).strict();
export const releaseConfig = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  source: z.string().url(),
}).strict();
export type RuntimeConfig = z.infer<typeof runtimeConfig>;

export async function readPrivateJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Private regular config file required');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export function createRuntimeApp(config: RuntimeConfig, pool: pg.Pool, metadata: z.infer<typeof releaseConfig>) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Link': `<${metadata.source}>; rel="source"`});
    next();
  });
  app.get('/health/live', (_req, res) => res.json({alive: true, sending: false, revision: metadata.revision}));
  app.get('/health/ready', async (_req, res) => {
    try {
      const result = await pool.query(`SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb AS unsafe,
        has_table_privilege(current_user,'isla_newsletter.deliveries','INSERT,UPDATE,DELETE') AS ledger_write
        FROM pg_roles r WHERE rolname=current_user`);
      if (!result.rows[0] || result.rows[0].unsafe || result.rows[0].ledger_write) throw new Error('Unsafe database role');
      await pool.query('SELECT id,revision,content FROM isla_newsletter.drafts LIMIT 0');
      await pool.query('SELECT draft_id,revision FROM isla_newsletter.draft_revisions LIMIT 0');
      res.json({ready: true, stage: 'locked-staging', staffAccess: false, sending: false,
        customerDispatch: false, revision: metadata.revision});
    } catch {
      res.status(503).json({ready: false, sending: false, error: 'Staging database unavailable or unsafe'});
    }
  });
  app.get('/source', (_req, res) => res.json({...metadata, license: 'AGPL-3.0',
    notice: 'ISLA modifications to Plunk. Complete corresponding source includes build scripts.'}));
  // No fixture auth, session minting, environment-based opt-in or provider credentials.
  app.use(createNewsletterDraftApp({enabled: false, websiteOrigin: config.websiteOrigin,
    staffSecret: '', staffDb: pool, newsletterDb: pool}));
  return app;
}

export async function startRuntime(configPath: string, releasePath: string) {
  const config = runtimeConfig.parse(await readPrivateJson(configPath));
  const db = databaseConfig.parse(await readPrivateJson(config.databaseFile));
  const metadata = releaseConfig.parse(JSON.parse(await readFile(releasePath, 'utf8')));
  const expected = `https://github.com/islainstruments/plunk/tree/${metadata.revision}`;
  if (metadata.source !== expected) throw new Error('Exact corresponding source required');
  const pool = new pg.Pool({...db, max: 3, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
    statement_timeout: 5000, query_timeout: 6000, application_name: 'isla-newsletter-staging'});
  pool.on('error', () => { /* Health check fails closed; never log connection details. */ });
  const app = createRuntimeApp(config, pool, metadata);
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(config.port, config.host, () => resolve(listening));
      listening.once('error', reject);
    });
  } catch (error) { await pool.end(); throw error; }
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return {server, close: async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    await pool.end();
  }};
}
