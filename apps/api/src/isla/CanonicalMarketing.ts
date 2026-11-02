/* ISLA modifications to Plunk, AGPL-3.0. Server-only marketing veto integration. */
import type {Pool} from 'pg';
import {normalizeEmail} from './NewsletterLedger.js';

/** Supabase is the cross-system marketing veto authority. The local append-only
 * ledger is also authoritative immediately: an unavailable replica never clears
 * a suppression. Existing website withdrawals are read, not rewritten (ReBorn's
 * withdrawal handler revokes access and must not be called here).
 * This class does NOT grant consent, resubscribe, import contacts or send mail.
 */
export class CanonicalMarketing {
  constructor(private readonly local: Pick<Pool, 'query'>, private readonly canonical: Pick<Pool, 'query'>) {}

  /** Call immediately before transport, in addition to ledger provenance/review
   * and local suppression checks. Network/query failures fail closed by throwing.
   * No positive result is cached. */
  async eligible(email: string): Promise<boolean> {
    const result = await this.canonical.query('SELECT isla_marketing.not_suppressed($1) AS eligible', [normalizeEmail(email)]);
    return result.rows[0]?.eligible === true;
  }

  /** Bounded durable outbox, safe for replay/concurrent callers. A suppression is
   * recorded remotely before acknowledging it locally. No global scan of website
   * contacts or copying of account/order/entitlement data occurs. */
  async synchronize(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid sync batch');
    const pending = await this.local.query(`SELECT s.* FROM isla_newsletter.suppressions s
      WHERE NOT EXISTS(SELECT 1 FROM isla_newsletter.suppression_exports e
        WHERE (e.email,e.reason,e.source,e.source_event_id)=(s.email,s.reason,s.source,s.source_event_id))
      ORDER BY s.effective_at,s.email,s.reason,s.source,s.source_event_id LIMIT $1`, [limit]);
    for (const event of pending.rows) {
      const identity = [event.email, event.reason, event.source, event.source_event_id];
      await this.canonical.query('SELECT isla_marketing.record_suppression($1,$2,$3,$4,$5)', [...identity, event.effective_at]);
      await this.local.query(`INSERT INTO isla_newsletter.suppression_exports(email,reason,source,source_event_id)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, identity);
    }
    return pending.rows.length;
  }
}
