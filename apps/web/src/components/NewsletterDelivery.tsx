/* ISLA provider adaptation of native Plunk campaign reporting. AGPL-3.0. */
import {Card, CardContent, CardHeader, CardTitle} from '@plunk/ui';
import useSWR from 'swr';
import {useState} from 'react';
import {network} from '../lib/network';
import {z} from 'zod';
const plainTextSchema = z.object({plainText: z.string().min(1).max(100000), revision: z.number().int().min(0)});

type Delivery = {
  intended: number; queued: number; accepted: number; skipped: number; review: number; unsubscribed: number;
  providerEvents: {event_type: string; total_events: number; unique_messages: number}[];
  caveat: string; trackingCapability: string;
  staffTests?: {intended: number; accepted: number};
};

export function NewsletterDelivery({campaignId}: {campaignId: string}) {
  const {data, error} = useSWR<Delivery>(`/campaigns/${campaignId}/delivery`, {refreshInterval: 30000});
  const {data: content, mutate: mutateContent} = useSWR<{plainText: string; revision: number}>(`/campaigns/${campaignId}/content`);
  const [text, setText] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  async function saveText() {
    if (!content || text === null) return;
    setSaving(true);
    try {
      const saved = await network.fetch<{plainText: string; revision: number}, typeof plainTextSchema>('PUT', `/campaigns/${campaignId}/content`, plainTextSchema.parse({plainText: text, revision: content.revision}));
      await mutateContent(saved, false); setText(null); setMessage('Plain text saved.');
    } catch {setMessage('Plain text was not saved. Reload to reconcile a conflicting revision or verify admin access.');}
    finally {setSaving(false);}
  }
  return <Card>
    <CardHeader><CardTitle>Resend delivery ledger</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p>Commissioning hold: all sends and customer imports remain disabled. Native SES counters are not Resend delivery evidence.</p>
      <label htmlFor="newsletter-plain-text" className="block font-medium">Reviewed plain-text alternative</label>
      <textarea id="newsletter-plain-text" className="w-full border rounded p-2 min-h-32" value={text ?? content?.plainText ?? ''} onChange={event => setText(event.target.value)} disabled={!content || saving} />
      <p>Saved separately from the native HTML editor; never regenerated from HTML. Liquid variables are preserved. A recipient-specific unsubscribe footer is appended by the delivery ledger.</p>
      <button type="button" onClick={() => void saveText()} disabled={!content || text === null || !text.trim() || saving} className="border rounded px-3 py-2 disabled:opacity-50">Save plain text</button>
      <p role="status">{message}</p>
      {error ? <p role="alert">Delivery ledger unavailable. No delivery figures can be inferred.</p> : !data ? <p>Loading delivery ledger…</p> : <>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(['intended', 'queued', 'accepted', 'skipped', 'review', 'unsubscribed'] as const).map(key =>
            <div key={key}><dt className="capitalize text-neutral-500">{key}</dt><dd>{data[key]}</dd></div>)}
        </dl>
        <p>Customer campaign figures only. Accepted means provider acceptance, not delivery. Intended counts immutable queued messages, not the current contact-list size. Unsubscribed counts unique recipients for this campaign.</p>
        <p>Separate staff-test ledger: {data.staffTests?.intended ?? 0} intended, {data.staffTests?.accepted ?? 0} accepted. Tests do not inflate customer metrics.</p>
        <table className="w-full text-left"><thead><tr><th>Provider event</th><th>Unique messages</th><th>Total events</th></tr></thead>
          <tbody>{['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.opened', 'email.clicked'].map(type => {
            const event = data.providerEvents.find(e => e.event_type === type);
            return <tr key={type}><td>{type}</td><td>{event?.unique_messages ?? 0}</td><td>{event?.total_events ?? 0}</td></tr>;
          })}</tbody></table>
        <p>Delivery denominator: accepted messages. Engagement denominator: delivered messages where observed. Zero means no recorded event, not proof that an action did not occur.</p>
        <p>{data.caveat}</p><p>Tracking: {data.trackingCapability}. Open/click tracking is not enabled by this deployment. Provider domain-level configuration must be verified before enabling any test.</p>
      </>}
    </CardContent>
  </Card>;
}
