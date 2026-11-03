/* ISLA operator-only single staff test. AGPL-3.0. No HTTP routes or workers. */
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import type {NewsletterLedger} from './NewsletterLedger.js';

export const staffTestAuthorization = 'brad-2026-11-02-one-test';
export const staffTestRecipient = 'brad@islaelectronics.com';
export const staffTestFrom = 'ISLA Electronics <noreply@islaelectronics.com>';

/** Read-only proof, inserted by Infrastructure (NOT writable by operator/web).
 * Review is not an unsubscribe. This exact one-test exception still requires
 * unchanged genuine consent, native identity, content and NO actual local veto.
 * Canonical eligibility remains a separate fresh check at the HTTP boundary. */
export async function reviewedStaffTestEligible(pool: Pool, contactId: string, email: string,
  campaignId: string, version: string): Promise<boolean> {
  if (email !== staffTestRecipient) return false;
  const row = (await pool.query(`SELECT c.consent_evidence,a.consent_sha256 FROM isla_newsletter.staff_test_review_audit a
    JOIN isla_newsletter.contacts c ON c.email=a.recipient
    JOIN public.contacts n ON n.id=a.native_contact_id AND n.email=a.recipient
    JOIN public.campaigns p ON p.id=a.campaign_id AND p."projectId"=n."projectId"
    WHERE a.authorization_id=$1 AND a.recipient=$2 AND a.native_contact_id=$3 AND a.campaign_id=$4
      AND a.content_version=$5 AND c.review=true AND c.consent_evidence IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM isla_newsletter.suppressions s WHERE s.email=a.recipient)`,
    [staffTestAuthorization, email, contactId, campaignId, version])).rows[0];
  return !!row?.consent_evidence && createHash('sha256').update(row.consent_evidence).digest('hex') === row.consent_sha256;
}

/** Persist a single delivery binding before any HTTP. Concurrent operators and
 * restarts cannot rotate campaign/revision/key after an uncertain acceptance.
 * Infrastructure must ALSO inspect Resend history before the first attempt. */
export async function reserveStaffTest(pool: Pool, deliveryId: string, version: string) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('isla-newsletter:one-staff-test',0))");
    const row = (await db.query(`SELECT d.*,c.purpose FROM isla_newsletter.deliveries d
      JOIN isla_newsletter.campaigns c ON c.id=d.campaign_id WHERE d.id=$1`, [deliveryId])).rows[0];
    if (!row || row.purpose !== 'test' || row.recipient !== staffTestRecipient || row.content_version !== version ||
      row.payload.from !== staffTestFrom || row.payload.reply_to !== staffTestRecipient)
      throw new Error('Staff test authorization mismatch');
    const prior = await db.query(`SELECT 1 FROM isla_newsletter.deliveries d
      JOIN isla_newsletter.campaigns c ON c.id=d.campaign_id
      WHERE c.purpose='test' AND d.id<>$1 AND (d.first_attempt_at IS NOT NULL OR d.provider_id IS NOT NULL) LIMIT 1`, [deliveryId]);
    if (prior.rowCount) throw new Error('Prior staff attempt requires reconciliation');
    await db.query(`INSERT INTO isla_newsletter.staff_test_authorizations(authorization_id,delivery_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING`, [staffTestAuthorization, deliveryId]);
    const binding = (await db.query('SELECT delivery_id FROM isla_newsletter.staff_test_authorizations WHERE authorization_id=$1', [staffTestAuthorization])).rows[0];
    if (binding?.delivery_id !== deliveryId) throw new Error('Single staff test already reserved');
    await db.query('COMMIT');
    return {id: deliveryId, version, recipient: staffTestRecipient, from: staffTestFrom, replyTo: staffTestRecipient};
  } catch (error) {await db.query('ROLLBACK'); throw error;}
  finally {db.release();}
}

export async function attemptStaffTest(pool: Pool, ledger: NewsletterLedger, deliveryId: string, version: string) {
  await reserveStaffTest(pool, deliveryId, version);
  // Ordinary paused/running ledger state still applies; no automatic retry loop.
  return ledger.attempt(deliveryId);
}
