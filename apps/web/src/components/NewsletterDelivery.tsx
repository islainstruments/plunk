/* ISLA provider adaptation, modified 2026-11-02. AGPL-3.0. */
import {Card, CardContent, CardHeader, CardTitle} from '@plunk/ui';
import useSWR from 'swr';
import {useState} from 'react';
import {network, NetworkError} from '../lib/network';
import {NewsletterMetrics, type DeliveryMetrics} from './NewsletterMetrics';
import {useChangeTracking} from '../lib/hooks/useChangeTracking';
import {z} from 'zod';
const plainTextSchema = z.object({plainText: z.string().min(1).max(100000), revision: z.number().int().min(0)});

export function NewsletterDelivery({campaignId}: {campaignId: string}) {
  const {data, error, mutate} = useSWR<DeliveryMetrics>(`/campaigns/${campaignId}/delivery`, {refreshInterval: 30000});
  const {data: content, error: contentError, mutate: mutateContent} = useSWR<{plainText: string; revision: number}>(`/campaigns/${campaignId}/content`);
  const [edit, setEdit] = useState<{plainText: string; revision: number} | null>(null);
  useChangeTracking(edit !== null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  async function saveText() {
    if (!content || !edit) return;
    setSaving(true);
    try {
      const saved = await network.fetch<{plainText: string; revision: number}, typeof plainTextSchema>('PUT', `/campaigns/${campaignId}/content`, plainTextSchema.parse(edit));
      await mutateContent(saved, false); setEdit(null); setMessage('Plain text saved.');
    } catch (error) {setMessage(error instanceof NetworkError && error.status === 409
      ? 'Revision conflict: your text is retained. Copy it before loading the latest saved version; changes have not been overwritten.'
      : `Plain text was not saved. ${error instanceof Error ? error.message : 'Check staff access and retry.'}`);}
    finally {setSaving(false);}
  }
  return <Card className="my-6 min-w-0 text-foreground">
    <CardHeader><CardTitle>Resend delivery ledger</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p>Commissioning hold: all sends and customer imports remain disabled. Native SES counters are not Resend delivery evidence.</p>
      <label htmlFor="newsletter-plain-text" className="block font-medium">Reviewed plain-text alternative</label>
      {contentError && <p role="alert">Plain text unavailable. {contentError.message} Your unsaved text is retained.</p>}
      <textarea id="newsletter-plain-text" aria-describedby="newsletter-text-help" maxLength={100000} className="w-full border border-input bg-background text-foreground rounded p-2 min-h-32 focus-visible:outline-2 focus-visible:outline-offset-2" value={edit?.plainText ?? content?.plainText ?? ''} onChange={event => {if (content) setEdit({plainText: event.target.value, revision: edit?.revision ?? content.revision});}} disabled={!content || saving} />
      <p id="newsletter-text-help">Saved separately from the native HTML editor; never regenerated from HTML. Liquid variables are preserved. A recipient-specific unsubscribe footer is appended to both HTML and plain text by the delivery ledger, without changing your saved draft.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => void saveText()} disabled={!content || !edit?.plainText.trim() || saving} className="border rounded px-3 py-2 disabled:opacity-50">{saving ? 'Saving plain text…' : 'Save plain text'}</button>
        <button type="button" onClick={() => {if (!edit || window.confirm('Discard unsaved plain-text edits and load the latest saved version? Copy any text you need first.')) {setEdit(null); void mutateContent(); setMessage('Loading latest saved version.');}}} disabled={saving} className="border rounded px-3 py-2">Load latest saved text</button>
      </div>
      <details><summary className="cursor-pointer py-2 font-medium">Plain-text preview (draft only)</summary><pre className="whitespace-pre-wrap break-words border rounded p-3 font-mono text-sm">{edit?.plainText ?? content?.plainText ?? 'No saved plain text yet.'}</pre><p>Unrendered draft: variables remain literal. No recipient token is created. The personalized unsubscribe footer is added only when an authorized recipient delivery is prepared; this preview cannot validate a live unsubscribe link or mailbox rendering.</p></details>
      <p role="status">{message}</p>
      {error ? <p role="alert">Delivery ledger unavailable. {error.message} No delivery figures can be inferred.</p> : !data ? <p role="status">Loading delivery ledger…</p> : <>
        <NewsletterMetrics data={data} label="Customer campaign ledger" />
        {data.staffTests ? <details><summary className="cursor-pointer py-2 font-medium">Separate staff-test ledger</summary><NewsletterMetrics data={data.staffTests} label="Staff-test ledger — excluded from customer totals" /></details> : <p>Staff-test figures unavailable, not zero.</p>}
        <p>{data.caveat}</p><p>Tracking capability: {data.trackingCapability}. Opens and clicks are unavailable: both provider domains have tracking disabled. No per-message tracking control is supported by the agreed transport.</p>
      </>}
      <fieldset disabled aria-describedby="newsletter-controls-help" className="rounded border p-3"><legend className="font-semibold">Commissioning controls — held</legend><div className="flex flex-wrap gap-2">{['Send staff test', 'Pause campaign', 'Resume campaign', 'Enable open tracking', 'Enable click tracking'].map(label => <button type="button" key={label} className="border rounded px-3 py-2 opacity-60">{label}</button>)}</div></fieldset>
      <p id="newsletter-controls-help">No commissioned test-send, pause/resume or tracking endpoints. Tests require explicitly designated staff/test addresses, sender and reply-to, plus a separate send release; never an arbitrary customer address. No test has been sent. Customer imports and customer sends are separate holds.</p>
      <button type="button" onClick={() => void mutate()} className="border rounded px-3 py-2">Refresh delivery ledger</button>
    </CardContent>
  </Card>;
}
