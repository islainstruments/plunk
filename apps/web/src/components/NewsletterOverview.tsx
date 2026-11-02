/* ISLA staff adaptation, 2026-11-02 — AGPL-3.0. Uses native campaign tools. */
import Link from 'next/link';
import {DashboardLayout} from './DashboardLayout';

export function NewsletterOverview({analytics = false}: {analytics?: boolean}) {
  return <DashboardLayout><div className="space-y-6 max-w-4xl">
    <header><h1 className="text-3xl font-bold">{analytics ? 'Analytics' : 'Staff newsletters'}</h1><p className="mt-2 text-muted-foreground">Native Plunk tools · Resend delivery ledger · Staff-only commissioning</p></header>
    <section className="rounded-lg border border-border bg-card p-6 space-y-3">
      <h2 className="text-xl font-semibold">{analytics ? 'Campaign-level evidence, not SES counters' : 'Draft safely; sending remains held'}</h2>
      <p>Open a native campaign to see its Resend ledger: prepared-to-date, queued, provider accepted, delivered, bounced, complained, unsubscribed, skipped and review. Customer and staff-test ledgers are separate. Provider acceptance is not delivery.</p>
      <p>Aggregate Resend analytics are unavailable. Upstream SES charts are deliberately not shown: zero SES counters would misrepresent newsletter delivery. Open/click tracking is not commissioned and both provider domains have tracking disabled; no per-message switch is supported. Privacy proxies and link scanners distort engagement, and opens do not prove human reading.</p>
      <Link className="inline-block rounded border px-4 py-3 font-semibold underline underline-offset-4" href="/campaigns">Open native campaigns and delivery ledgers</Link>
    </section>
    <div className="grid sm:grid-cols-2 gap-4">
      {([['/templates', 'Reusable templates', 'Create, edit, duplicate and preview content using the native Plunk editor.'], ['/segments', 'Audience segments', 'Manage reusable audience definitions. Membership and validation are not consent.'], ['/contacts', 'Contacts and suppression', 'Inspect native status and durable marketing vetoes. Imports never undo opt-outs.'], ['/campaigns/create', 'Create a draft campaign', 'Review HTML and separately preserved plain text; no customer campaign is authorized.']] as const).map(([href, title, text]) => <Link key={href} href={href} className="block rounded-lg border border-border bg-card p-5 focus-visible:outline-2 focus-visible:outline-offset-2"><h2 className="font-semibold underline underline-offset-4">{title}</h2><p className="mt-2 text-sm text-muted-foreground">{text}</p></Link>)}
    </div>
    <section aria-label="Commissioning limits" className="space-y-2 rounded border border-border p-5"><h2 className="font-semibold">Independent holds</h2><p>Customer imports are held pending reviewed migration acceptance. All sends, including tests, remain held pending designated staff/test addresses, sender/reply-to and a separate send release. Pause/resume controls are not commissioned. No customer address should be used for commissioning.</p><p>Draft previews are not delivered messages. Recipient-specific unsubscribe footers in HTML and plain text are added during authorized delivery preparation; previews do not validate a real mailbox or token. Newsletter opt-out does not change essential account, order or licence mail.</p></section>
  </div></DashboardLayout>;
}
