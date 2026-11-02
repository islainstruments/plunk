/* ISLA native contact import policy. AGPL-3.0. Updated 2026-11-02. No workflow events or sending. */
import type {PrismaClient} from '@plunk/db';
import {z} from 'zod';
import {HttpException} from '../exceptions/index.js';
import {normalizeEmail} from './NewsletterLedger.js';

const evidence = z.object({
  provenance: z.array(z.object({sourceCategory: z.string().min(1).max(100), sourceSystem: z.string().min(1).max(100),
    sourceRecordId: z.string().min(1).max(500), observedAt: z.string().datetime()})).min(1).max(100),
  priorSends: z.array(z.object({campaignId: z.string().min(1), reference: z.string().min(1), state: z.string().min(1)})).max(1000).default([]),
  review: z.boolean(), consentEvidence: z.string().min(1).max(4000).optional(),
}).strict();
const input = z.object({email: z.string(), subscribed: z.boolean().default(false),
  data: z.object({isla: evidence}).passthrough()}).strict();

export const approvedSourceCategories = ['Shopify customers', 'current Auth accounts', 'website subscribers', 'product notify', 'ReBorn'] as const;

/** The native POST /contacts controller calls this adapter. Identity, evidence and
 * native contact updates commit together. Re-import can only strengthen vetoes;
 * it cannot erase history, clear review or restore a subscription. */
export class NativeContactImport {
  constructor(private readonly prisma: PrismaClient, private readonly projectId: string,
    private readonly canonicalEligible: (email: string) => Promise<boolean>,
    private readonly customerImports = false) {}

  /** Read-only projection. Never turn a canonical veto into a subscription write. */
  async marketingStatus(id: string) {
    const contact = await this.prisma.contact.findFirst({where: {id, projectId: this.projectId}});
    if (!contact) throw Object.assign(new Error('Contact unavailable'), {code: 404});
    const [evidence] = await this.prisma.$queryRaw<{review: boolean; consent_evidence: string | null}[]>`
      SELECT review,consent_evidence FROM isla_newsletter.contacts WHERE email=${contact.email}`;
    const vetoes = await this.prisma.$queryRaw<{reason: string}[]>`
      SELECT DISTINCT reason FROM isla_newsletter.suppressions WHERE email=${contact.email} ORDER BY reason`;
    let state: 'not_suppressed' | 'suppressed' | 'unavailable' = 'unavailable';
    let checkedAt: string | null = null;
    try {
      state = await this.canonicalEligible(contact.email) ? 'not_suppressed' : 'suppressed';
      checkedAt = new Date().toISOString();
    } catch { /* No stale positive or private dependency error is returned. */ }
    const localVetoes = vetoes.map(v => v.reason);
    const review = evidence?.review ?? true;
    const consentEvidencePresent = !!evidence?.consent_evidence;
    const knownVeto = !contact.subscribed || review || !consentEvidencePresent || localVetoes.length > 0 || state === 'suppressed';
    return {version: 1, nativeSubscribed: contact.subscribed, review, localVetoes, consentEvidencePresent,
      canonical: {state, reason: state === 'suppressed' ? 'canonical-marketing-veto' : null, checkedAt},
      eligible: knownVeto ? false : state === 'unavailable' ? null : true};
  }

  async upsert(body: unknown) {
    const parsed = input.safeParse(body);
    if (!parsed.success) throw new HttpException(400, 'Contact provenance/review evidence required');
    const row = parsed.data;
    let email: string;
    try {email = normalizeEmail(row.email);} catch {throw new HttpException(400, 'Invalid email');}
    // Commission readiness with non-routable fixtures without releasing migration.
    if (!this.customerImports && !email.endsWith('.invalid')) throw new HttpException(423, 'Customer imports held');
    if (!email.endsWith('.invalid') && row.data.isla.provenance.some(p =>
      !approvedSourceCategories.some(category => category === p.sourceCategory)))
      throw new HttpException(400, 'Approved source category required');
    const canonical = await this.canonicalEligible(email); // unavailable => no write
    const incoming = row.data.isla;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`isla-newsletter:recipient:${email}`},0))`;
      await tx.$executeRaw`INSERT INTO isla_newsletter.contacts(email,provenance,prior_sends,review,consent_evidence)
        VALUES(${email},${JSON.stringify(incoming.provenance)}::jsonb,${JSON.stringify(incoming.priorSends)}::jsonb,${incoming.review},${incoming.consentEvidence ?? null})
        ON CONFLICT(email) DO UPDATE SET
          provenance=(SELECT coalesce(jsonb_agg(DISTINCT p),'[]'::jsonb) FROM jsonb_array_elements(isla_newsletter.contacts.provenance || excluded.provenance) p),
          prior_sends=(SELECT coalesce(jsonb_agg(DISTINCT p),'[]'::jsonb) FROM jsonb_array_elements(isla_newsletter.contacts.prior_sends || excluded.prior_sends) p),
          review=isla_newsletter.contacts.review OR excluded.review,updated_at=now()`;
      const [state] = await tx.$queryRaw<{provenance: unknown; prior_sends: unknown; review: boolean; consent_evidence: string | null; suppressed: boolean}[]>`
        SELECT c.*,EXISTS(SELECT 1 FROM isla_newsletter.suppressions s WHERE s.email=c.email) AS suppressed
        FROM isla_newsletter.contacts c WHERE c.email=${email}`;
      if (!state) throw new Error('Missing import evidence');
      const existing = await tx.contact.findUnique({where: {projectId_email: {projectId: this.projectId, email}}});
      const subscribed = row.subscribed && canonical && !state.suppressed && !state.review && !!state.consent_evidence && existing?.subscribed !== false;
      // Explicit false is a marketing veto, never merely a transient list filter.
      if (!row.subscribed) await tx.$executeRaw`INSERT INTO isla_newsletter.suppressions(email,reason,source,source_event_id,effective_at)
        VALUES(${email},'unsubscribe','native-import','explicit-opt-out',now()) ON CONFLICT DO NOTHING`;
      const oldData = existing?.data && typeof existing.data === 'object' && !Array.isArray(existing.data) ? existing.data : {};
      const data = JSON.parse(JSON.stringify({...oldData,...row.data,isla: {provenance: state.provenance,
        priorSends: state.prior_sends,review: state.review,consentEvidence: state.consent_evidence}}));
      const contact = await tx.contact.upsert({where: {projectId_email: {projectId: this.projectId,email}},
        create: {projectId: this.projectId,email,data,subscribed}, update: {data,subscribed}});
      return {...contact,_meta: {isNew: !existing,isUpdate: !!existing}};
    });
  }
}
