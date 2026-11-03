/* ISLA modifications to Plunk — AGPL-3.0. Updated 2026-11-02. Non-sending by default. */
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {Webhook} from 'svix';

export type SuppressionReason = 'unsubscribe' | 'hard_bounce' | 'complaint' | 'withdrawal' | 'quarantine';
export interface ContactInput {
  email: string;
  provenance: {sourceCategory: string; sourceSystem: string; sourceRecordId: string; observedAt: string}[];
  priorSends?: {campaignId: string; reference: string; state: string}[];
  review: boolean;
  consentEvidence?: string;
}
export interface DraftPayload {
  from: string;
  reply_to: string;
  subject: string;
  html: string;
  text: string;
}
export interface Options {
  /** Default disabled. No customer dispatch mode exists in commissioning code. */
  mode?: 'disabled' | 'staff-test';
  designatedRecipients?: string[];
  apiKey?: string;
  /** Operator-only immutable one-test pin; never populated from HTTP input. */
  authorizedDelivery?: {id: string; version: string; recipient: string; from: string; replyTo: string};
  /** Operator-only immutable review audit; does NOT relax any suppression or consent check. */
  reviewedStaffTest?: (recipient: string, version: string) => Promise<boolean>;
  /** Must consult canonical eligibility, not just cached Plunk contact state. */
  eligibility: (email: string) => Promise<boolean>;
  publicOrigin: string;
  webhookSecret: string;
  intervalMs?: number;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}
export const normalizeEmail = (value: string): string => {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) throw new Error('Invalid email');
  return email;
};
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const retryWindowMs = 23 * 60 * 60 * 1000;
const supportedEvents = new Set([
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
  'email.failed',
  'email.suppressed',
]);

export class NewsletterLedger {
  private readonly now: () => Date;
  private readonly transport: typeof globalThis.fetch;
  private readonly allowlist: Set<string>;
  private readonly origin: string;
  private readonly interval: number;
  constructor(
    private readonly pool: Pool,
    private readonly options: Options,
  ) {
    const url = new URL(options.publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Public HTTPS origin required');
    this.origin = url.origin;
    this.now = options.clock ?? (() => new Date());
    this.transport = options.fetch ?? globalThis.fetch;
    this.allowlist = new Set((options.designatedRecipients ?? []).map(normalizeEmail));
    this.interval = options.intervalMs ?? 1000;
    if (!Number.isFinite(this.interval) || this.interval < 500)
      throw new Error('Newsletter rate must be <= 2 requests/second');
  }
  /** Session locks survive intermediate commits, release even when an operation fails. */
  private async locked<T>(keys: string | string[], work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    const acquired: string[] = [];
    let failed = false;
    try {
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['isla-newsletter:' + key]);
        acquired.push(key);
      }
      return await work(db);
    } finally {
      try {
        for (const key of acquired.reverse())
          await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['isla-newsletter:' + key]);
      } catch {
        failed = true;
      }
      db.release(failed);
    }
  }
  async importContact(row: ContactInput): Promise<void> {
    const email = normalizeEmail(row.email);
    if (
      !row.provenance.length ||
      row.provenance.some(
        p => !p.sourceCategory || !p.sourceSystem || !p.sourceRecordId || !Number.isFinite(Date.parse(p.observedAt)),
      )
    )
      throw new Error('Provenance required');
    // Re-import never clears prior review flags or overwrites provenance/history.
    // Any change to eligibility requires a separately audited review/consent flow.
    await this.pool.query(
      `INSERT INTO isla_newsletter.contacts(email,provenance,prior_sends,review,consent_evidence)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO UPDATE SET
      provenance=(SELECT coalesce(jsonb_agg(DISTINCT p),'[]'::jsonb) FROM jsonb_array_elements(isla_newsletter.contacts.provenance || excluded.provenance) p),
      prior_sends=(SELECT coalesce(jsonb_agg(DISTINCT p),'[]'::jsonb) FROM jsonb_array_elements(isla_newsletter.contacts.prior_sends || excluded.prior_sends) p),
      review=isla_newsletter.contacts.review OR excluded.review, updated_at=now()`,
      [
        email,
        JSON.stringify(row.provenance),
        JSON.stringify(row.priorSends ?? []),
        row.review,
        row.consentEvidence ?? null,
      ],
    );
  }
  async suppress(
    email: string,
    reason: SuppressionReason,
    source: string,
    eventId: string,
    effectiveAt = this.now(),
  ): Promise<void> {
    email = normalizeEmail(email);
    await this.locked('recipient:' + email, db =>
      this.insertSuppression(db, email, reason, source, eventId, effectiveAt),
    );
  }
  private async insertSuppression(
    db: PoolClient,
    email: string,
    reason: SuppressionReason,
    source: string,
    eventId: string,
    at: Date,
  ): Promise<void> {
    await db.query(
      `INSERT INTO isla_newsletter.suppressions(email,reason,source,source_event_id,effective_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [email, reason, source, eventId, at],
    );
  }
  async createCampaign(id: string, purpose: 'test' | 'customer'): Promise<void> {
    await this.pool.query('INSERT INTO isla_newsletter.campaigns(id,purpose) VALUES($1,$2)', [id, purpose]);
  }
  async freezeCampaign(id: string, version: string): Promise<void> {
    await this.locked('campaign:' + id, async db => {
      await db.query("INSERT INTO isla_newsletter.campaigns(id,purpose,content_version) VALUES($1,'customer',$2) ON CONFLICT DO NOTHING", [id, version]);
      const row = (await db.query('SELECT content_version,purpose FROM isla_newsletter.campaigns WHERE id=$1', [id])).rows[0];
      if (row.content_version !== version || row.purpose !== 'customer') throw new Error('Prepared native campaign revision is frozen');
    });
  }
  async belongsToProject(deliveryId: string, projectId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM isla_newsletter.deliveries d JOIN public.campaigns c
      ON d.campaign_id IN ('staff-test-' || c.id, 'customer-' || c.id) WHERE d.id=$1 AND c."projectId"=$2`, [deliveryId, projectId]);
    return !!result.rowCount;
  }
  async setCampaignState(id: string, state: 'draft' | 'paused' | 'running'): Promise<void> {
    await this.locked('campaign:' + id, async db => {
      const result = await db.query('UPDATE isla_newsletter.campaigns SET state=$2 WHERE id=$1', [id, state]);
      if (!result.rowCount) throw new Error('Campaign not found');
    });
  }
  async enqueue(campaignId: string, version: string, recipient: string, draft: DraftPayload): Promise<string> {
    recipient = normalizeEmail(recipient);
    if (
      !version ||
      !draft.subject.trim() ||
      !draft.html.trim() ||
      !draft.text.trim() ||
      !draft.reply_to ||
      /[\r\n]/.test(draft.from + draft.reply_to + draft.subject)
    )
      throw new Error('Complete HTML/text and safe headers required');
    normalizeEmail(draft.reply_to);
    const fromAddress = /<([^<>]+)>$/.exec(draft.from)?.[1] ?? draft.from;
    if (!normalizeEmail(fromAddress).endsWith('@islaelectronics.com'))
      throw new Error('Verified sending domain required');
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const url = `${this.origin}/newsletters/unsubscribe/${token}`;
    const payload = {
      from: draft.from,
      reply_to: draft.reply_to,
      to: [recipient],
      subject: draft.subject,
      html: draft.html + `<footer><a href="${url}">Unsubscribe from Isla marketing emails</a></footer>`,
      text: draft.text + `\n\nUnsubscribe from Isla marketing emails: ${url}\n`,
      headers: {'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'},
      tags: [
        {name: 'isla_delivery_id', value: id},
        {name: 'isla_campaign_id', value: campaignId},
      ],
    };
    const result = await this.pool.query(
      `INSERT INTO isla_newsletter.deliveries
      (id,campaign_id,recipient,content_version,payload,idempotency_key,token_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(campaign_id,content_version,recipient) DO NOTHING RETURNING id`,
      [id, campaignId, recipient, version, JSON.stringify(payload), 'isla-newsletter/' + id, digest(token)],
    );
    if (result.rows[0]) return id;
    return (
      await this.pool.query(
        'SELECT id FROM isla_newsletter.deliveries WHERE campaign_id=$1 AND content_version=$2 AND recipient=$3',
        [campaignId, version, recipient],
      )
    ).rows[0].id as string;
  }
  /** Confirmation GET must never call this; both human-confirmation and RFC8058 POST may. */
  async unsubscribe(token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const row = (
      await this.pool.query('SELECT recipient,id FROM isla_newsletter.deliveries WHERE token_hash=$1', [digest(token)])
    ).rows[0];
    if (row) await this.suppress(row.recipient as string, 'unsubscribe', 'newsletter', row.id as string);
    // Unknown token deliberately behaves like a successful unsubscribe.
  }
  async attempt(id: string): Promise<string> {
    if (this.options.mode !== 'staff-test' || !this.options.apiKey || !this.allowlist.size) return 'disabled';
    const delivery = (
      await this.pool.query('SELECT recipient,campaign_id FROM isla_newsletter.deliveries WHERE id=$1', [id])
    ).rows[0];
    if (!delivery) return 'missing';
    return this.locked(['recipient:' + delivery.recipient, 'campaign:' + delivery.campaign_id], async db => {
      const row = (
        await db.query(
          `SELECT d.*,c.state,c.purpose,ct.review,ct.consent_evidence FROM isla_newsletter.deliveries d
        JOIN isla_newsletter.campaigns c ON c.id=d.campaign_id JOIN isla_newsletter.contacts ct ON ct.email=d.recipient WHERE d.id=$1`,
          [id],
        )
      ).rows[0];
      if (!row || row.status !== 'queued') return row?.status ?? 'missing';
      if (row.purpose !== 'test') return 'customer-dispatch-disabled';
      const pin = this.options.authorizedDelivery;
      if (pin && (row.id !== pin.id || row.content_version !== pin.version || row.recipient !== pin.recipient ||
        row.payload.from !== pin.from || row.payload.reply_to !== pin.replyTo)) return 'staff-test-not-authorized';
      if (row.state !== 'running') return 'paused';
      if (!this.allowlist.has(row.recipient as string)) return 'recipient-not-designated';
      if (row.next_attempt_at && new Date(row.next_attempt_at).getTime() > this.now().getTime()) return 'deferred';
      const suppressed = (
        await db.query('SELECT 1 FROM isla_newsletter.suppressions WHERE email=$1 LIMIT 1', [row.recipient])
      ).rowCount;
      if (
        suppressed ||
        (row.review && !(pin && this.options.reviewedStaffTest &&
          await this.options.reviewedStaffTest(row.recipient as string, row.content_version as string))) ||
        !row.consent_evidence ||
        !(await this.options.eligibility(row.recipient as string))
      ) {
        await db.query("UPDATE isla_newsletter.deliveries SET status='skipped',reason='ineligible' WHERE id=$1", [id]);
        return 'skipped';
      }
      if (row.first_attempt_at && this.now().getTime() - new Date(row.first_attempt_at).getTime() >= retryWindowMs) {
        await db.query(
          "UPDATE isla_newsletter.deliveries SET status='review',reason='idempotency-window-expired' WHERE id=$1",
          [id],
        );
        return 'review';
      }
      // Reserve an account-shared newsletter slot atomically. The website still needs
      // coordinated quota headroom before this can be enabled in production.
      const slot = await db.query(
        `UPDATE isla_newsletter.provider_throttle SET next_at=$1::timestamptz + $2 * interval '1 millisecond'
        WHERE singleton=true AND next_at <= $1 RETURNING singleton`,
        [this.now(), this.interval],
      );
      if (!slot.rowCount) return 'throttled';
      // The limiter/DB wait is not a consent cache. Recheck after acquiring the
      // slot, as close to the HTTP boundary as possible. A remote veto committed
      // after this query cannot recall an already in-flight provider request.
      if (!(await this.options.eligibility(row.recipient as string)) ||
        (await db.query('SELECT 1 FROM isla_newsletter.suppressions WHERE email=$1 LIMIT 1', [row.recipient])).rowCount) {
        await db.query("UPDATE isla_newsletter.deliveries SET status='skipped',reason='ineligible' WHERE id=$1", [id]);
        return 'skipped';
      }
      // AUTOCOMMIT before HTTP: survive a killed process after provider acceptance.
      await db.query(
        'UPDATE isla_newsletter.deliveries SET first_attempt_at=coalesce(first_attempt_at,$2), attempts=attempts+1 WHERE id=$1',
        [id, this.now()],
      );
      let response: Response;
      try {
        response = await this.transport('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + this.options.apiKey,
            'Content-Type': 'application/json',
            'Idempotency-Key': row.idempotency_key as string,
          },
          body: JSON.stringify(row.payload),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        await db.query(
          "UPDATE isla_newsletter.deliveries SET next_attempt_at=$2,reason='provider-response-uncertain' WHERE id=$1",
          [id, new Date(this.now().getTime() + 60000)],
        );
        return 'uncertain';
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500 || response.status === 409;
        const raw = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(raw) && raw > 0 ? Math.max(60, Math.min(raw, 82800)) : 60;
        if (response.status === 429) await db.query(`UPDATE isla_newsletter.provider_throttle
          SET next_at=greatest(next_at,$1) WHERE singleton=true`, [new Date(this.now().getTime() + delay * 1000)]);
        await db.query(`UPDATE isla_newsletter.deliveries SET status=$2,next_attempt_at=$3,reason=$4 WHERE id=$1`, [
          id,
          retryable ? 'queued' : 'review',
          new Date(this.now().getTime() + delay * 1000),
          'provider-http-' + response.status,
        ]);
        return retryable ? 'retry' : 'review';
      }
      let providerId: string;
      try {
        const result = (await response.json()) as {id?: unknown};
        if (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.id))
          throw new Error('Invalid response');
        providerId = result.id;
      } catch {
        await db.query(
          "UPDATE isla_newsletter.deliveries SET next_attempt_at=$2,reason='provider-response-uncertain' WHERE id=$1",
          [id, new Date(this.now().getTime() + 60000)],
        );
        return 'uncertain';
      }
      await db.query(
        "UPDATE isla_newsletter.deliveries SET status='accepted',provider_id=$2,accepted_at=$3,reason=NULL WHERE id=$1",
        [id, providerId, this.now()],
      );
      await this.applyProviderSuppressions(db, providerId, row.recipient as string);
      return 'accepted';
    });
  }
  private async applyProviderSuppressions(db: PoolClient, providerId: string, email: string): Promise<void> {
    const events = await db.query(
      "SELECT * FROM isla_newsletter.provider_events WHERE provider_id=$1 AND event_type IN ('email.bounced','email.complained','email.suppressed')",
      [providerId],
    );
    for (const event of events.rows) {
      const reason: SuppressionReason =
        event.event_type === 'email.complained'
          ? 'complaint'
          : event.event_type === 'email.bounced' && event.bounce_type === 'Permanent'
            ? 'hard_bounce'
            : 'quarantine';
      await this.insertSuppression(db, email, reason, 'resend', event.event_id as string, new Date(event.occurred_at));
    }
  }
  /** Repair crashes after signed-event persistence without needing a replay. */
  async reconcileProviderEvents(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid reconciliation batch');
    const pending = await this.pool.query(`SELECT DISTINCT d.provider_id,d.recipient
      FROM isla_newsletter.provider_events e JOIN isla_newsletter.deliveries d ON d.provider_id=e.provider_id
      WHERE e.event_type IN ('email.bounced','email.complained','email.suppressed')
        AND NOT EXISTS(SELECT 1 FROM isla_newsletter.suppressions s
          WHERE s.email=d.recipient AND s.source='resend' AND s.source_event_id=e.event_id)
      ORDER BY d.provider_id,d.recipient LIMIT $1`, [limit]);
    for (const row of pending.rows) await this.locked('recipient:' + row.recipient,
      db => this.applyProviderSuppressions(db, row.provider_id as string, row.recipient as string));
    return pending.rows.length;
  }
  async ingestWebhook(raw: string, headers: Record<string, string>): Promise<'recorded' | 'duplicate' | 'ignored'> {
    new Webhook(this.options.webhookSecret).verify(raw, headers);
    const verified = JSON.parse(raw) as {type?: unknown; created_at?: unknown; data?: {email_id?: unknown; bounce?: {type?: unknown}}};
    if (typeof verified.type !== 'string' || !supportedEvents.has(verified.type)) return 'ignored';
    if (
      typeof verified.data?.email_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(verified.data.email_id) ||
      typeof verified.created_at !== 'string' ||
      !Number.isFinite(Date.parse(verified.created_at))
    )
      throw new Error('Invalid provider event');
    const providerId = verified.data.email_id;
    const eventId = headers['svix-id'];
    if (!eventId) throw new Error('Missing event id');
    // Record first, then reconcile on every replay as well: crash between these two
    // steps must not turn a duplicate into a permanently lost suppression.
    const inserted = await this.pool.query(
      `INSERT INTO isla_newsletter.provider_events(event_id,provider_id,event_type,occurred_at,bounce_type)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id`,
      [eventId, providerId, verified.type, verified.created_at,
        verified.type === 'email.bounced' && verified.data.bounce?.type === 'Permanent' ? 'Permanent' : null],
    );
    // On replay reconcile the original persisted identity, never a conflicting
    // replay body. Unrelated provider IDs are retained but cannot target contacts.
    const original = (await this.pool.query('SELECT provider_id FROM isla_newsletter.provider_events WHERE event_id=$1', [eventId])).rows[0];
    const recordedProviderId = original.provider_id as string;
    const delivery = (
      await this.pool.query('SELECT recipient FROM isla_newsletter.deliveries WHERE provider_id=$1', [recordedProviderId])
    ).rows[0];
    if (delivery)
      await this.locked('recipient:' + delivery.recipient, db =>
        this.applyProviderSuppressions(db, recordedProviderId, delivery.recipient as string),
      );
    return inserted.rowCount ? 'recorded' : 'duplicate';
  }
  async analytics(campaignId: string): Promise<Record<string, unknown>> {
    const manifest = (await this.pool.query(`SELECT a.frozen_at,
      count(m.contact_id)::int AS selected,
      count(m.contact_id) FILTER(WHERE m.exclusion IS NOT NULL)::int AS excluded,
      count(m.contact_id) FILTER(WHERE m.exclusion IS NULL AND (a.prepared_cursor IS NULL OR m.contact_id>a.prepared_cursor))::int AS remaining
      FROM isla_newsletter.audience_manifests a LEFT JOIN isla_newsletter.audience_members m ON m.campaign_id=a.campaign_id
      WHERE a.campaign_id=$1 GROUP BY a.campaign_id`, [campaignId])).rows[0] ?? null;
    const deliveries = (
      await this.pool.query(
        `SELECT count(*)::int AS intended,
      count(*) FILTER(WHERE status='queued')::int AS queued,
      count(*) FILTER(WHERE accepted_at IS NOT NULL)::int AS accepted,
      count(*) FILTER(WHERE status='skipped')::int AS skipped,
      count(*) FILTER(WHERE status='review')::int AS review
      FROM isla_newsletter.deliveries WHERE campaign_id=$1`,
        [campaignId],
      )
    ).rows[0];
    const events = (
      await this.pool.query(
        `SELECT e.event_type,count(*)::int AS total_events,count(DISTINCT d.id)::int AS unique_messages
      FROM isla_newsletter.provider_events e JOIN isla_newsletter.deliveries d ON d.provider_id=e.provider_id
      WHERE d.campaign_id=$1 GROUP BY e.event_type`,
        [campaignId],
      )
    ).rows;
    const unsubscribed = (
      await this.pool.query(
        `SELECT count(DISTINCT s.email)::int AS recipients FROM isla_newsletter.suppressions s
      JOIN isla_newsletter.deliveries d ON d.id=s.source_event_id WHERE d.campaign_id=$1 AND s.reason='unsubscribe' AND s.source='newsletter'`,
        [campaignId],
      )
    ).rows[0]?.recipients;
    return {
      ...deliveries,
      unsubscribed,
      providerEvents: events,
      denominators: {delivery: 'accepted messages', engagement: 'delivered messages (where observed)'},
      caveat:
        'Acceptance is not delivery. Opens/clicks include proxy/scanner activity; total_events counts provider events, not guaranteed individual human actions.',
      trackingCapability: 'not commissioned',
      manifest,
    };
  }
}
