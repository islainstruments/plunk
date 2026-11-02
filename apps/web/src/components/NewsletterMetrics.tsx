/* ISLA modifications, 2026-11-02 — AGPL-3.0. Native Resend ledger presentation. */
export type DeliveryMetrics = {
  intended: number; queued: number; accepted: number; skipped: number; review: number; unsubscribed: number;
  providerEvents: {event_type: string; total_events: number; unique_messages: number}[];
  denominators?: {delivery: string; engagement: string};
  caveat: string; trackingCapability: string;
  manifest?: null | {frozen_at: string; selected: number; excluded: number; remaining: number};
  staffTests?: DeliveryMetrics;
};

export function NewsletterMetrics({data, label}: {data: DeliveryMetrics; label: string}) {
  const delivered = data.providerEvents.find(event => event.event_type === 'email.delivered')?.unique_messages ?? 0;
  const eventRows = [
    ['email.sent', 'Provider sent event'], ['email.delivered', 'Delivered'],
    ['email.bounced', 'Bounced'], ['email.complained', 'Complained'],
    ['email.opened', 'Opened'], ['email.clicked', 'Clicked'],
  ];
  return <section className="space-y-3" aria-label={label}>
    <h3 className="font-semibold">{label}</h3>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {([
        ['intended', 'Prepared / intended to date'], ['queued', 'Queued'], ['accepted', 'Accepted by provider'],
        ['skipped', 'Skipped'], ['review', 'Needs review'], ['unsubscribed', 'Unsubscribed recipients'],
      ] as const).map(([key, title]) => <div key={key} className="rounded border border-border p-3">
        <dt className="text-muted-foreground">{title}</dt><dd className="text-xl font-semibold tabular-nums">{data[key]}</dd>
      </div>)}
    </dl>
    <p>Prepared counts durable delivery rows to date, not a final audience size. Queued excludes accepted messages; skipped and review are not successful sends. Acceptance is not delivery.</p>
    {data.manifest ? <p>Frozen audience snapshot: {data.manifest.selected} selected, {data.manifest.excluded} excluded, {data.manifest.remaining} remaining to prepare. Frozen at {data.manifest.frozen_at}. Remaining is not a delivered count.</p> : <p>Frozen audience manifest unavailable — no final audience total or completion percentage can be inferred.</p>}
    <div className="overflow-x-auto rounded border border-border" tabIndex={0} role="region" aria-label={`${label} event counts`}>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{label}: distinct provider events and unique delivery messages, not unique people.</caption>
        <thead><tr>{['Provider evidence', 'Unique messages', 'Total events', 'Unique-message rate'].map(title => <th scope="col" key={title} className="p-2">{title}</th>)}</tr></thead>
        <tbody>{eventRows.map(([type, title]) => {
          const event = data.providerEvents.find(item => item.event_type === type);
          const engagement = type === 'email.opened' || type === 'email.clicked';
          // Tracking has not been commissioned: an absent event is NOT zero engagement.
          const available = !engagement;
          const denominator = engagement ? delivered : data.accepted;
          const count = event?.unique_messages ?? 0;
          return <tr key={type} className="border-t border-border">
            <th scope="row" className="p-2 font-medium">{title}</th>
            <td className="p-2 tabular-nums">{available ? count : 'Unavailable'}</td>
            <td className="p-2 tabular-nums">{available ? event?.total_events ?? 0 : 'Unavailable'}</td>
            <td className="p-2">{!available ? 'Tracking not commissioned' : denominator > 0 ? `${(100 * count / denominator).toFixed(1)}% (${count} / ${denominator} accepted)` : 'N/A — no accepted messages'}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p>Delivery/event denominator: {data.accepted} accepted messages. Engagement denominator: {delivered} observed delivered messages; no delivered messages means no rate. Total events are distinct provider records; unique messages deduplicate delivery IDs, not people. Counts can overlap across event types. Unsubscribes count distinct campaign-attributed recipients, not all global opt-outs.</p>
    <p>Zero means no recorded event, not proof nothing happened. Opens are unreliable evidence of reading; privacy proxies and link scanners can inflate opens and clicks. No unique-human or link-level analytics are claimed.</p>
  </section>;
}
