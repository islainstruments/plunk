/* ISLA 2026-11-02, AGPL-3.0. No DB, secrets, network or real recipients. */
import {describe, expect, it, vi} from 'vitest';
import type {PrismaClient} from '@plunk/db';
import type {NewsletterLedger} from '../NewsletterLedger.js';
import {NativeNewsletterDelivery} from '../NativeNewsletterDelivery.js';

describe('native preference variables must never bypass the opaque footer', () => {
  it.each(['{{unsubscribeUrl}}', '{{ unsubscribeUrl }}', '{{subscribeUrl}}', '{{ manageUrl }}'])(
    'rejects upstream capability %s on both preparation paths', async body => {
      const db = {campaign: {findFirst: vi.fn().mockResolvedValue({body, status: 'DRAFT', type: 'MARKETING'})},
        contact: {findFirst: vi.fn().mockResolvedValue({subscribed: true})}};
      const ledger = {enqueue: vi.fn(), freezeCampaign: vi.fn()};
      const adapter = new NativeNewsletterDelivery(db as unknown as PrismaClient,
        ledger as unknown as NewsletterLedger, 'fixture-project');
      await expect(adapter.prepareStaffTest('fixture', 'fixture@example.invalid', 'Fixture text')).rejects.toThrow('preference');
      await expect(adapter.prepareCampaignPage('fixture', 'Fixture text')).rejects.toThrow('preference');
      expect(ledger.enqueue).not.toHaveBeenCalled();
      expect(ledger.freezeCampaign).not.toHaveBeenCalled();
    },
  );
});
