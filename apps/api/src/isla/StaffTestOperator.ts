/* Infrastructure-only operator entrypoint. AGPL-3.0. NEVER invoked by web runtime. */
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {z} from 'zod';
import {databaseConfig, staffDatabaseConfig, readPrivateJson} from './NewsletterRuntime.js';
import {NewsletterLedger} from './NewsletterLedger.js';
import {NativeNewsletterDelivery} from './NativeNewsletterDelivery.js';
import {CanonicalMarketing} from './CanonicalMarketing.js';
import {reserveStaffTest, reviewedStaffTestEligible, staffTestAuthorization, staffTestFrom, staffTestRecipient} from './StaffTestCommissioning.js';

const approval = z.object({
  authorization: z.literal(staffTestAuthorization), campaignId: z.string().min(1),
  version: z.string().regex(/^[a-f0-9]{64}$/).optional(), deliveryId: z.string().uuid().optional(),
  credentialFile: z.string().startsWith('/').optional(),
  providerHistoryCheckedAt: z.string().datetime().optional(),
  providerHistoryReference: z.string().min(1).optional(),
  quotaCheckedAt: z.string().datetime().optional(), quotaReference: z.string().min(1).optional(),
}).strict();
const fresh = (at?: string) => !!at && Date.now() - Date.parse(at) >= 0 && Date.now() - Date.parse(at) < 10 * 60 * 1000;

async function run() {
  const action = process.argv[2];
  if (!['inspect', 'prepare', 'resume', 'pause', 'attempt', 'status'].includes(action ?? '')) throw Error('Action required');
  const cfg = approval.parse(await readPrivateJson('/run/newsletter/staff-test-release.json'));
  // Separate short-lived operator role: never grant ledger writes to web runtime.
  const db = databaseConfig.parse(await readPrivateJson('/run/newsletter/staff-test-database.json'));
  if (db.user !== 'plunk_staff_test_operator') throw Error('Scoped operator role required');
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.database}?connection_limit=2`;
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL;
  const {prisma} = await import('../database/prisma.js');
  const pool = new pg.Pool({...db, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000});
  let canonicalPool: pg.Pool | undefined;
  try {
    const project = await prisma.project.findFirst({where: {name: 'ISLA Staff Newsletters'}});
    if (!project) throw Error('Project unavailable');
    if (action === 'status') {
      const result = await pool.query(`SELECT d.id,d.content_version,d.status,d.provider_id,d.first_attempt_at,d.attempts,d.reason
        FROM isla_newsletter.staff_test_authorizations a JOIN isla_newsletter.deliveries d ON d.id=a.delivery_id
        WHERE a.authorization_id=$1 AND d.campaign_id=$2`, [staffTestAuthorization, 'staff-test-' + cfg.campaignId]);
      console.log(JSON.stringify(result.rows)); return;
    }
    const canonicalConfig = await readPrivateJson('/run/newsletter/canonical-database.json') as Record<string, unknown>;
    if (typeof canonicalConfig.user !== 'string' || !/^isla_newsletter_marketing(?:\.[a-z0-9]+)?$/.test(canonicalConfig.user)) throw Error('Scoped canonical role required');
    const target = staffDatabaseConfig.parse({...canonicalConfig, user: 'isla_newsletter_staff_read'});
    const {caFile, tlsServerName, ...connection} = target;
    canonicalPool = new pg.Pool({...connection, user: canonicalConfig.user, max: 1, connectionTimeoutMillis: 3000,
      statement_timeout: 3000, ssl: {rejectUnauthorized: true, servername: tlsServerName, ca: await readFile(caFile, 'utf8'), minVersion: 'TLSv1.2'}});
    const canonical = new CanonicalMarketing(pool, canonicalPool);
    let ledger = new NewsletterLedger(pool, {mode: 'disabled', publicOrigin: 'https://islaelectronics.com', webhookSecret: '', eligibility: email => canonical.eligible(email)});
    const reviewProof = async (contactId: string, email: string, campaignId: string, version: string) =>
      reviewedStaffTestEligible(pool, contactId, email, campaignId, version);
    const adapter = new NativeNewsletterDelivery(prisma, ledger, project.id, reviewProof);
    if (action === 'inspect') {
      const {version, draft} = await adapter.staffTestRevision(cfg.campaignId, staffTestRecipient);
      if (draft.from !== staffTestFrom || draft.reply_to !== staffTestRecipient) throw Error('Sender mismatch');
      console.log(JSON.stringify({campaignId: cfg.campaignId, version, sending: false})); return;
    }
    if (!cfg.version) throw Error('Frozen version required');
    if (action === 'prepare') {
      const id = await adapter.prepareStaffTest(cfg.campaignId, staffTestRecipient, undefined, cfg.version);
      await reserveStaffTest(pool, id, cfg.version);
      console.log(JSON.stringify({deliveryId: id, version: cfg.version, sending: false})); return;
    }
    if (!cfg.deliveryId || !await ledger.belongsToProject(cfg.deliveryId, project.id)) throw Error('Project delivery required');
    const row = (await pool.query('SELECT campaign_id FROM isla_newsletter.deliveries WHERE id=$1', [cfg.deliveryId])).rows[0];
    if (row?.campaign_id !== 'staff-test-' + cfg.campaignId) throw Error('Campaign mismatch');
    const pin = await reserveStaffTest(pool, cfg.deliveryId, cfg.version);
    if (action === 'pause' || action === 'resume') {
      await ledger.setCampaignState(row.campaign_id, action === 'pause' ? 'paused' : 'running');
      console.log(JSON.stringify({state: action === 'pause' ? 'paused' : 'running', sending: false})); return;
    }
    if (!fresh(cfg.providerHistoryCheckedAt) || !cfg.providerHistoryReference || !fresh(cfg.quotaCheckedAt) || !cfg.quotaReference || !cfg.credentialFile)
      throw Error('Fresh provider-history and transactional quota-reserve checks required');
    const credential = z.object({apiKey: z.string().min(10)}).strict().parse(await readPrivateJson(cfg.credentialFile));
    ledger = new NewsletterLedger(pool, {mode: 'staff-test', apiKey: credential.apiKey, designatedRecipients: [staffTestRecipient], authorizedDelivery: pin,
      reviewedStaffTest: async (email, version) => {
        const contact = await prisma.contact.findFirst({where: {projectId: project.id, email}});
        return !!contact && await reviewProof(contact.id, email, cfg.campaignId, version);
      },
      publicOrigin: 'https://islaelectronics.com', webhookSecret: '', intervalMs: 2000,
      eligibility: async email => {
        const contact = await prisma.contact.findFirst({where: {projectId: project.id, email}});
        return !!contact && (contact.subscribed || await reviewProof(contact.id, email, cfg.campaignId, cfg.version!)) && await canonical.eligible(email);
      }});
    console.log(JSON.stringify({deliveryId: cfg.deliveryId, result: await ledger.attempt(cfg.deliveryId)}));
  } finally {await prisma.$disconnect(); await pool.end(); await canonicalPool?.end();}
}
run().catch(() => {console.error('Staff test operation rejected; inspect private release, history, quota, campaign and ledger. No credential/content details logged.'); process.exitCode = 1;});
