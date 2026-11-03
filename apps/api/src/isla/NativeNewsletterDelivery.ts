/* Native Plunk to Resend ledger adapter. AGPL-3.0. Never auto-dispatches. */
import {createHash} from 'node:crypto';
import {renderTemplate} from '@plunk/shared';
import type {PrismaClient} from '@plunk/db';
import type {NewsletterLedger} from './NewsletterLedger.js';
import {NativeAudience} from './NativeAudience.js';


/** The native editor/campaign remain the source of content and audience. The
 * immutable ledger is the source of delivery/retry/suppression facts. This
 * adapter must only be called after a separately authorized commissioning gate.
 * No import, worker or enabled send route is installed by constructing it. */
export class NativeNewsletterDelivery {
  constructor(private readonly db: PrismaClient, private readonly ledger: NewsletterLedger,
    private readonly projectId: string,
    private readonly reviewedStaffTest?: (contactId: string, email: string, campaignId: string, version: string) => Promise<boolean>) {}

  async staffTestRevision(campaignId: string, recipient: string, plainText?: string) {
    plainText ??= (await this.content(campaignId)).plainText;
    if (!plainText.trim()) throw new Error('Explicit reviewed plain text required');
    const campaign = await this.db.campaign.findFirst({where: {id: campaignId, projectId: this.projectId}});
    if (!campaign || campaign.status !== 'DRAFT' || campaign.type !== 'MARKETING')
      throw new Error('Native marketing draft required');
    const contact = await this.db.contact.findFirst({where: {projectId: this.projectId, email: recipient}});
    if (!contact) throw new Error('Native contact is ineligible');
    // Preserve Liquid personalization, but preference URLs are generated per
    // immutable ledger delivery; never use upstream contact-id unsubscribe URLs.
    if (/{{\s*(?:unsubscribeUrl|subscribeUrl|manageUrl)\b/.test(campaign.body))
      throw new Error('Replace upstream preference variables with the ledger footer');
    const data = {email: contact.email, data: contact.data ?? {},
      ...((contact.data as Record<string, unknown> | null) ?? {})};
    const html = renderTemplate(campaign.body, data);
    const subject = renderTemplate(campaign.subject, data);
    const text = renderTemplate(plainText, data);
    const draft = {from: campaign.fromName ? `${campaign.fromName} <${campaign.from}>` : campaign.from,
      reply_to: campaign.replyTo ?? campaign.from, subject, html, text};
    const version = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    if (!contact.subscribed && !await this.reviewedStaffTest?.(contact.id, contact.email, campaignId, version))
      throw new Error('Native contact is ineligible');
    return {draft, version};
  }
  async prepareStaffTest(campaignId: string, recipient: string, plainText?: string, expectedVersion?: string): Promise<string> {
    const {draft, version} = await this.staffTestRevision(campaignId, recipient, plainText);
    if (expectedVersion !== undefined && version !== expectedVersion) throw new Error('Staff test content revision mismatch');
    // Separate test identity makes accidental customer-purpose promotion impossible.
    const ledgerId = 'staff-test-' + campaignId;
    try {await this.ledger.createCampaign(ledgerId, 'test');}
    catch (error) {if (!error || typeof error !== 'object' || !('code' in error) || error.code !== '23505') throw error;}
    return this.ledger.enqueue(ledgerId, version, recipient, draft);
  }
  private async assertOwned(campaignId: string) {
    if (!await this.db.campaign.findFirst({where: {id: campaignId, projectId: this.projectId}}))
      throw new Error('Native campaign unavailable');
  }
  async content(campaignId: string) {
    await this.assertOwned(campaignId);
    const rows = await this.db.$queryRaw<{plain_text: string; revision: number}[]>`
      SELECT plain_text,revision FROM isla_newsletter.native_content WHERE campaign_id=${campaignId} AND project_id=${this.projectId}`;
    return {plainText: rows[0]?.plain_text ?? '', revision: rows[0]?.revision ?? 0};
  }
  async saveContent(campaignId: string, text: string, revision: number) {
    if (!text.trim() || text.length > 100000 || !Number.isInteger(revision) || revision < 0) throw Object.assign(new Error('Reviewed plain text and revision required'), {code: 400});
    const campaign = await this.db.campaign.findFirst({where: {id: campaignId, projectId: this.projectId, status: 'DRAFT', type: 'MARKETING'}});
    if (!campaign) throw new Error('Native marketing draft required');
    const rows = revision === 0 ? await this.db.$queryRaw<{revision: number}[]>`
      INSERT INTO isla_newsletter.native_content(campaign_id,project_id,plain_text) VALUES(${campaignId},${this.projectId},${text})
      ON CONFLICT DO NOTHING RETURNING revision` : await this.db.$queryRaw<{revision: number}[]>`
      UPDATE isla_newsletter.native_content SET plain_text=${text},revision=revision+1,updated_at=now()
      WHERE campaign_id=${campaignId} AND project_id=${this.projectId} AND revision=${revision} RETURNING revision`;
    if (!rows[0]) throw Object.assign(new Error('Content revision conflict'), {code: 409});
    return {plainText: text, revision: rows[0].revision};
  }
  async pause(campaignId: string) {
    await this.assertOwned(campaignId);
    await this.ledger.setCampaignState('staff-test-' + campaignId, 'paused');
  }
  async resumeStaffTest(campaignId: string) {
    await this.assertOwned(campaignId);
    await this.ledger.setCampaignState('staff-test-' + campaignId, 'running');
  }
  /** Internal native audience traversal, never installed as an HTTP dispatch route.
   * Customer purpose stays non-dispatchable even if staff test transport opens. */
  async prepareCampaignPage(campaignId: string, plainText?: string, cursor?: string, priorAnnouncementIds = [campaignId]) {
    // Progress is durable server-side, never supplied by a caller after restart.
    if (cursor !== undefined) throw new Error('Use durable manifest cursor');
    plainText ??= (await this.content(campaignId)).plainText;
    if (!plainText.trim()) throw new Error('Explicit reviewed plain text required');
    const campaign = await this.db.campaign.findFirst({where: {id: campaignId, projectId: this.projectId}});
    if (!campaign || campaign.status !== 'DRAFT' || campaign.type !== 'MARKETING')
      throw new Error('Native marketing draft required');
    if (/{{\s*(?:unsubscribeUrl|subscribeUrl|manageUrl)\b/.test(campaign.body))
      throw new Error('Replace upstream preference variables with the ledger footer');
    const ledgerId = 'customer-' + campaignId;
    const version = createHash('sha256').update(JSON.stringify({
      subject: campaign.subject, body: campaign.body, from: campaign.from, fromName: campaign.fromName,
      replyTo: campaign.replyTo, audienceType: campaign.audienceType,
      audienceCondition: campaign.audienceCondition, segmentId: campaign.segmentId, plainText,
    })).digest('hex');
    await this.ledger.freezeCampaign(ledgerId, version);
    // CampaignService reads validated runtime constants on import. Defer it until
    // after NativePlunkServer has loaded its private configuration.
    const {CampaignService} = await import('../services/CampaignService.js');
    const audience = new NativeAudience(this.db);
    await audience.freeze(ledgerId, version,
      await CampaignService.buildRecipientWhereAsync(this.projectId, campaign), priorAnnouncementIds);
    const contacts = await audience.page(ledgerId);
    for (const contact of contacts) {
      const data = {email: contact.email, data: contact.personalization,
        ...contact.personalization};
      await this.ledger.enqueue(ledgerId, version, contact.email, {
        from: campaign.fromName ? `${campaign.fromName} <${campaign.from}>` : campaign.from,
        reply_to: campaign.replyTo ?? campaign.from,
        subject: renderTemplate(campaign.subject, data), html: renderTemplate(campaign.body, data),
        text: renderTemplate(plainText, data),
      });
    }
    const last = contacts[contacts.length - 1]?.contact_id;
    if (last) await audience.advance(ledgerId, last);
    return {prepared: contacts.length, nextCursor: last, hasMore: (await audience.page(ledgerId)).length > 0};
  }
  async attempt(deliveryId: string) {
    if (!await this.ledger.belongsToProject(deliveryId, this.projectId)) throw new Error('Native delivery unavailable');
    return this.ledger.attempt(deliveryId);
  }
  async analytics(campaignId: string) {
    await this.assertOwned(campaignId);
    return {...await this.ledger.analytics('customer-' + campaignId),
      scope: 'customer', staffTests: await this.ledger.analytics('staff-test-' + campaignId)};
  }
}
