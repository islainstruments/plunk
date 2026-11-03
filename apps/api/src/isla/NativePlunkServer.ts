/* ISLA native Plunk runtime. AGPL-3.0. No send workers or scheduler. */
import {readFile} from 'node:fs/promises';
import {createServer, request} from 'node:http';
import {spawn} from 'node:child_process';
import express from 'express';
import pg from 'pg';
import {z} from 'zod';
import {NewsletterLedger} from './NewsletterLedger.js';
import {NativeNewsletterDelivery} from './NativeNewsletterDelivery.js';
import {NativeContactImport} from './NativeContactImport.js';
import {CanonicalMarketing} from './CanonicalMarketing.js';
import {newsletterRouter} from './NewsletterRouter.js';
import {databaseConfig, staffDatabaseConfig, readPrivateJson} from './NewsletterRuntime.js';
import {websiteStaffLookup} from './StaffBoundary.js';
import {resendProjectDomains} from './ResendDomains.js';

let startupStage = 'configuration';
async function start() {
  const config = await readPrivateJson('/run/newsletter/config.json') as {websiteOrigin: string};
  if (config.websiteOrigin !== 'https://islaelectronics.com') throw new Error('Wrong website origin');
  const db = databaseConfig.parse(await readPrivateJson('/run/newsletter/native-database.json'));
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.database}?connection_limit=4`;
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL;
  process.env.REDIS_URL = 'redis://newsletter-native-redis:6379';
  process.env.EMAIL_TRANSPORT = 'held';
  process.env.JWT_SECRET = 'unused-native-auth-disabled-no-token-issuer';
  process.env.API_URI = config.websiteOrigin + '/staff/newsletters/api';
  process.env.DASHBOARD_URI = config.websiteOrigin + '/staff/newsletters/plunk';
  process.env.LANDING_URI = config.websiteOrigin;
  process.env.WIKI_URI = 'https://github.com/islainstruments/plunk';
  process.env.DISABLE_SIGNUPS = 'true';
  process.env.SHOW_SPONSOR = 'false';
  startupStage = 'staff-configuration';
  const staff = staffDatabaseConfig.parse(await readPrivateJson('/run/newsletter/staff-database.json'));
  const {caFile, tlsServerName, ...connection} = staff;
  const pool = new pg.Pool({...connection, ssl: {rejectUnauthorized: true, servername: tlsServerName,
    ca: await readFile(caFile, 'utf8'), minVersion: 'TLSv1.2'}, max: 2,
    connectionTimeoutMillis: 3000, statement_timeout: 3000, query_timeout: 4000});
  pool.on('error', () => {});
  const lookup = websiteStaffLookup(pool, await readFile('/run/newsletter/session-secret', 'utf8'));
  // Import only after the private connection configuration is set. Controllers
  // initialize queue clients, but no queue workers are ever loaded by this host.
  startupStage = 'native-imports';
  const [{createNativePlunkApp}, {nativePlunkControllers}, {prisma}, {redis}] = await Promise.all([
    import('./NativePlunkApp.js'), import('./NativePlunkControllers.js'),
    import('../database/prisma.js'), import('../database/redis.js'),
  ]);
  startupStage = 'native-database';
  const project = await prisma.project.findFirst({where: {name: 'ISLA Staff Newsletters'}});
  if (!project) throw new Error('Native project not commissioned');
  startupStage = 'canonical-configuration';
  const ledgerPool = new pg.Pool({...db, max: 3, connectionTimeoutMillis: 3000, statement_timeout: 5000});
  ledgerPool.on('error', () => {});
  const canonicalConfig = await readPrivateJson('/run/newsletter/canonical-database.json') as Record<string, unknown>;
  if (typeof canonicalConfig.user !== 'string' || !/^isla_newsletter_marketing(?:\.[a-z0-9]+)?$/.test(canonicalConfig.user)) throw new Error('Scoped marketing role required');
  // Validate the same fixed TLS target as staff access; only the scoped role differs.
  const canonicalTarget = staffDatabaseConfig.parse({...canonicalConfig, user: staff.user});
  startupStage = 'canonical-pool';
  const {caFile: canonicalCa, tlsServerName: canonicalName, ...canonicalConnection} = canonicalTarget;
  const canonicalPool = new pg.Pool({...canonicalConnection, user: canonicalConfig.user,
    ssl: {rejectUnauthorized: true, servername: canonicalName, ca: await readFile(canonicalCa, 'utf8'), minVersion: 'TLSv1.2'},
    max: 2, connectionTimeoutMillis: 3000, statement_timeout: 3000, query_timeout: 4000});
  canonicalPool.on('error', () => {});
  const canonical = new CanonicalMarketing(ledgerPool, canonicalPool);
  // Private operator release only. Missing file preserves the historical hold;
  // malformed/over-permissive files fail startup rather than enabling imports.
  let customerImports = false;
  try {
    customerImports = z.object({customerImports: z.boolean()}).strict()
      .parse(await readPrivateJson('/run/newsletter/import-release.json')).customerImports;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  startupStage = 'delivery-ledger';
  // No provider credential, allowlist or send worker exists in held mode.
  let webhookSecret = '';
  try { webhookSecret = (await readFile('/run/newsletter/resend-webhook-secret', 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const ledger = new NewsletterLedger(ledgerPool, {mode: 'disabled', publicOrigin: config.websiteOrigin,
    webhookSecret, eligibility: async email => {
      const contact = await prisma.contact.findFirst({where: {projectId: project.id, email, subscribed: true}});
      return !!contact && await canonical.eligible(email);
    }});
  // Durable outbox retries are independent of dispatch. Never clear suppressions.
  let syncing = false;
  const syncTimer = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void (async () => {
      await ledger.reconcileProviderEvents();
      // Reflect local vetoes in native contact screens without emitting native
      // workflow events or touching essential website/account records.
      await ledgerPool.query(`UPDATE public.contacts c SET subscribed=false WHERE c."projectId"=$1
        AND c.subscribed=true AND EXISTS(SELECT 1 FROM isla_newsletter.suppressions s WHERE s.email=c.email)`, [project.id]);
      await canonical.synchronize();
    })().catch(() => {}).finally(() => {syncing = false;});
  }, 15000);
  const publicApi = express();
  publicApi.use((req, res, next) => {
    if (req.path === '/newsletters/webhooks/resend' && !webhookSecret) return res.sendStatus(503);
    next();
  });
  publicApi.use(newsletterRouter(ledger, lookup, config.websiteOrigin));
  const api = createNativePlunkApp({origin: config.websiteOrigin, projectId: project.id, lookup,
    customerImports,
    providerDomains: () => resendProjectDomains(project.id),
    contactImport: new NativeContactImport(prisma, project.id, email => canonical.eligible(email), customerImports),
    delivery: new NativeNewsletterDelivery(prisma, ledger, project.id),
    controllers: nativePlunkControllers(), project: () => prisma.project.findUnique({where: {id: project.id}}),
    ready: async () => {await prisma.$queryRaw`SELECT 1`; await redis.ping(); await ledgerPool.query('SELECT id FROM isla_newsletter.deliveries LIMIT 0'); await pool.query('SELECT id,role,active FROM public.staff_users LIMIT 0'); await canonical.eligible('readiness-probe@example.invalid');},
  });
  startupStage = 'native-frontend';
  const frontend = spawn(process.execPath, ['--max-old-space-size=384', '/app/web/apps/web/server.js'], {
    env: {...process.env, HOSTNAME: '127.0.0.1', PORT: '4198'}, stdio: ['ignore', 'ignore', 'ignore'],
  });
  frontend.once('exit', () => process.exit(1));
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.url === '/health/ready') {
        req.url = '/health/ready'; return api(req, res);
      }
      if (req.url?.startsWith('/newsletters/')) return publicApi(req, res);
      if (req.url?.startsWith('/staff/newsletters/api/')) {
        req.url = req.url.slice('/staff/newsletters/api'.length); return api(req, res);
      }
      if (!await lookup(req as unknown as import('express').Request)) {
        res.writeHead(401); return res.end('Existing website staff sign-in required');
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!/^\/staff\/newsletters\/plunk(?:\/(?:_next|assets|templates|contacts|segments|campaigns|analytics|activity)(?:\/|$)|\/?$)/.test(path)) {
        res.writeHead(423); return res.end('Uncommissioned action held');
      }
      const upstream = request({hostname: '127.0.0.1', port: 4198, path: req.url, method: req.method,
        headers: req.headers}, response => {res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);});
      upstream.setTimeout(12000, () => upstream.destroy());
      upstream.on('error', () => {if (!res.headersSent) res.writeHead(502); res.end();});
      req.pipe(upstream);
    } catch {res.writeHead(503); res.end('Staff authorization unavailable');}
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.listen(4197, '0.0.0.0');
  async function stop() {
    clearInterval(syncTimer);
    frontend.removeAllListeners('exit'); frontend.kill('SIGTERM'); server.closeAllConnections(); server.close();
    const queues = await import('../services/QueueService.js');
    await Promise.all(Object.entries(queues).filter(([name, value]) => name.endsWith('Queue') && typeof (value as {close?: unknown}).close === 'function')
      .map(([, value]) => (value as {close: () => Promise<void>}).close()));
    await prisma.$disconnect(); await redis.quit(); await pool.end(); await ledgerPool.end(); await canonicalPool.end(); process.exit(0);
  }
  process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
}
start().catch(error => {console.error('Native Plunk startup failed at ' + startupStage + ' (' + (error instanceof Error ? error.name : 'unknown') + '); inspect private configuration'); process.exit(1);});
