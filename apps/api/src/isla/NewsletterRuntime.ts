/* ISLA isolated non-sending runtime. AGPL-3.0. No upstream app/ledger/worker imports. */
import {readFile, stat} from 'node:fs/promises';
import type {Server} from 'node:http';

import express from 'express';
import pg from 'pg';
import {z} from 'zod';

import {createNewsletterDraftApp} from './NewsletterDraftApp.js';

const commonConfig = z.object({
  websiteOrigin: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
  }),
  host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  port: z.number().int().min(1024).max(65535),
  databaseFile: z.string().startsWith('/'),
}).strict();
export const runtimeConfig = z.discriminatedUnion('auth', [
  commonConfig.extend({auth: z.literal('locked')}),
  commonConfig.extend({auth: z.literal('website'), staffDatabaseFile: z.string().startsWith('/'),
    staffSecretFile: z.string().startsWith('/')}),
]);
export const staffDatabaseConfig = z.object({
  host: z.string().regex(/^(?:[a-z0-9-]+\.)+supabase\.com$|^staff-db-proxy$/),
  port: z.union([z.literal(5432), z.literal(4196)]),
  database: z.literal('postgres'),
  user: z.string().regex(/^isla_newsletter_staff_read(?:\.[a-z0-9]+)?$/),
  password: z.string().min(32),
  tlsServerName: z.string().regex(/^(?:[a-z0-9-]+\.)+supabase\.com$/),
  caFile: z.string().startsWith('/'),
}).strict().refine(value => value.host === value.tlsServerName && (value.port === 5432 || value.port === 4196),
  'Verified direct/session TLS hostname required, including fixed-destination proxy connections');
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

export function createRuntimeApp(config: RuntimeConfig, pool: pg.Pool, metadata: z.infer<typeof releaseConfig>,
  binding?: {pool: pg.Pool; secret: string}) {
  if (config.auth === 'website' && (!binding || binding.secret.length < 32)) throw new Error('Scoped website binding required');
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
      if (config.auth === 'website') {
        const staff = await binding!.pool.query(`SELECT current_user = 'isla_newsletter_staff_read'
          AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
          AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
          AND NOT has_schema_privilege(current_user,'public','CREATE')
          AND NOT has_table_privilege(current_user,'public.staff_users','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
            AND (c.relowner=r.oid OR (c.relkind IN ('r','v','m','f','p') AND c.oid <> 'public.staff_users'::regclass
              AND has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
              AND NOT (c.relkind='v' AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
                WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'
                  AND e.extname='pg_stat_statements')))))
          AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
            WHERE grantee=current_user AND table_schema='public' AND table_name='staff_users'
              AND (privilege_type <> 'SELECT' OR column_name NOT IN ('id','role','active'))) AS safe
          FROM pg_roles r WHERE rolname=current_user`);
        if (!staff.rows[0]?.safe) throw new Error('Unsafe staff role');
        await binding!.pool.query('SELECT id,role,active FROM public.staff_users LIMIT 0');
      }
      res.json({ready: true, stage: config.auth === 'website' ? 'staff-draft-only' : 'locked-staging', staffAccess: config.auth === 'website', sending: false,
        customerDispatch: false, revision: metadata.revision});
    } catch {
      res.status(503).json({ready: false, sending: false, error: 'Staging database unavailable or unsafe'});
    }
  });
  app.get('/source', (_req, res) => res.json({...metadata, license: 'AGPL-3.0',
    notice: 'ISLA modifications to Plunk. Complete corresponding source includes build scripts.'}));
  // No fixture auth, session minting or provider credentials.
  app.use(createNewsletterDraftApp({enabled: config.auth === 'website', websiteOrigin: config.websiteOrigin,
    staffSecret: binding?.secret ?? '', staffDb: binding?.pool ?? pool, newsletterDb: pool, source: metadata.source}));
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
  let binding: {pool: pg.Pool; secret: string} | undefined;
  if (config.auth === 'website') {
    const staff = staffDatabaseConfig.parse(await readPrivateJson(config.staffDatabaseFile));
    const secretInfo = await stat(config.staffSecretFile);
    if (!secretInfo.isFile() || (secretInfo.mode & 0o077) !== 0) throw new Error('Private staff secret required');
    const secret = await readFile(config.staffSecretFile, 'utf8');
    if (secret.length < 32) throw new Error('Strong staff secret required');
    const {caFile, tlsServerName, ...connection} = staff;
    const staffPool = new pg.Pool({...connection, ssl: {rejectUnauthorized: true,
      ca: await readFile(caFile, 'utf8'), servername: tlsServerName, minVersion: 'TLSv1.2'},
      max: 2, connectionTimeoutMillis: 3000, statement_timeout: 3000, query_timeout: 4000,
      idleTimeoutMillis: 10000, application_name: 'isla-newsletter-staff-read'});
    staffPool.on('error', () => { /* Never log private connection details. */ });
    binding = {pool: staffPool, secret};
  }
  const app = createRuntimeApp(config, pool, metadata, binding);
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(config.port, config.host, () => resolve(listening));
      listening.once('error', reject);
    });
  } catch (error) { await binding?.pool.end(); await pool.end(); throw error; }
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return {server, close: async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    await pool.end();
    await binding?.pool.end();
  }};
}
