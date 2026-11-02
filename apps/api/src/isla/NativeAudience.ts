/* ISLA modifications, 2026-11-02. AGPL-3.0. Held native audience manifest. */
import type {PrismaClient, Prisma} from '@plunk/db';

/** Atomic membership/personalization snapshot with bounded memory. Definition
 * resolution is supplied explicitly and persisted; later segment/contact edits
 * cannot change the snapshot. A timeout rolls back the entire freeze, not a
 * partial audience. No customer dispatch or consent is granted here. */
export class NativeAudience {
  constructor(private readonly db: PrismaClient) {}

  async freeze(id: string, version: string, where: Prisma.ContactWhereInput, exclusions: string[]) {
    const policy = JSON.stringify([...new Set(exclusions)].sort());
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`isla-newsletter:manifest:${id}`},0))`;
      const existing = await tx.$queryRaw<{version: string; exclusions: unknown}[]>`
        SELECT version,exclusions FROM isla_newsletter.audience_manifests WHERE campaign_id=${id}`;
      if (existing[0]) {
        if (existing[0].version !== version || JSON.stringify(existing[0].exclusions) !== policy)
          throw new Error('Audience revision/policy is frozen');
        return;
      }
      await tx.$executeRaw`INSERT INTO isla_newsletter.audience_manifests(campaign_id,version,selection,exclusions)
        VALUES(${id},${version},${JSON.stringify(where)}::jsonb,${policy}::jsonb)`;
      let cursor: string | undefined;
      for (;;) {
        const contacts = await tx.contact.findMany({where, take: 100, orderBy: {id: 'asc'},
          ...(cursor ? {cursor: {id: cursor}, skip: 1} : {})});
        if (!contacts.length) break;
        // One insert per page; prior-announcement evidence of ANY state is a
        // conservative exclusion, never permission to replay an uncertain send.
        await tx.$executeRaw`INSERT INTO isla_newsletter.audience_members(campaign_id,contact_id,email,personalization,exclusion)
          SELECT ${id},x.id,x.email,x.data,
            CASE WHEN c.email IS NULL THEN 'missing-evidence'
              WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(c.prior_sends) p
                WHERE p->>'campaignId' IN (SELECT jsonb_array_elements_text(${policy}::jsonb))) THEN 'prior-announcement'
              WHEN c.review OR c.consent_evidence IS NULL THEN 'review-or-no-consent'
              WHEN EXISTS(SELECT 1 FROM isla_newsletter.suppressions s WHERE s.email=x.email) THEN 'suppressed'
              ELSE NULL END
          FROM jsonb_to_recordset(${JSON.stringify(contacts.map(c => ({id: c.id, email: c.email, data: c.data ?? {}})))}::jsonb)
            AS x(id text,email text,data jsonb)
          LEFT JOIN isla_newsletter.contacts c ON c.email=x.email`;
        cursor = contacts[contacts.length - 1]!.id;
      }
    }, {isolationLevel: 'RepeatableRead', timeout: 60000, maxWait: 5000});
  }

  async page(id: string) {
    return this.db.$queryRaw<{contact_id: string; email: string; personalization: Record<string, unknown>}[]>`
      SELECT m.contact_id,m.email,m.personalization FROM isla_newsletter.audience_members m
      JOIN isla_newsletter.audience_manifests a ON a.campaign_id=m.campaign_id
      WHERE m.campaign_id=${id} AND m.exclusion IS NULL
        AND (a.prepared_cursor IS NULL OR m.contact_id>a.prepared_cursor)
      ORDER BY m.contact_id LIMIT 100`;
  }

  async advance(id: string, cursor: string) {
    // Commit only after all immutable payloads in the page have been inserted.
    // A crash before this point replays the same page with the same delivery IDs.
    await this.db.$executeRaw`UPDATE isla_newsletter.audience_manifests
      SET prepared_cursor=CASE WHEN prepared_cursor IS NULL OR prepared_cursor<${cursor} THEN ${cursor} ELSE prepared_cursor END
      WHERE campaign_id=${id}`;
  }
}
