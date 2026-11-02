/* ISLA modification 2026-11-02 — AGPL-3.0. Authoritative read-only projection. */
import useSWR from 'swr';

type Status = {
  version: 1; nativeSubscribed: boolean; review: boolean; localVetoes: string[];
  canonical: {state: 'not_suppressed' | 'suppressed' | 'unavailable'; reason: 'canonical-marketing-veto' | null; checkedAt: string | null};
  eligible: boolean | null; consentEvidencePresent: boolean;
};

export function MarketingStatus({contactId}: {contactId: string}) {
  const {data, error, mutate, isValidating} = useSWR<Status>(`/contacts/${contactId}/marketing-status`, {refreshInterval: 30000});
  return <section aria-label="Durable marketing suppression" className="rounded-lg border border-border bg-card p-5 space-y-3 text-sm">
    <h2 className="text-lg font-semibold">Durable marketing suppression</h2>
    <p>Imports and resyncs cannot undo marketing opt-outs, hard-bounce/complaint vetoes or sticky review. Validation and list membership are not consent. Essential account, order and licence email is separate.</p>
    {error ? <p role="alert">Suppression details unavailable. {error.message} Do not infer eligibility from the native subscribed badge.</p> : !data ? <p role="status">Checking local and canonical marketing vetoes…</p> : <>
      <dl className="grid sm:grid-cols-2 gap-3">
        <div><dt className="text-muted-foreground">Present eligibility</dt><dd className="font-semibold">{data.eligible === null ? 'Unknown — fail closed' : data.eligible ? 'No current veto reported — not send authorization' : 'Excluded from marketing'}</dd></div>
        <div><dt className="text-muted-foreground">Native subscription</dt><dd>{data.nativeSubscribed ? 'Subscribed flag only' : 'Not subscribed'}</dd></div>
        <div><dt className="text-muted-foreground">Local durable vetoes</dt><dd>{data.localVetoes.length ? data.localVetoes.join(', ') : 'None reported locally — canonical check still required'}</dd></div>
        <div><dt className="text-muted-foreground">Canonical check</dt><dd>{data.canonical.state === 'suppressed' ? 'Suppressed — canonical marketing veto (detailed reason unavailable)' : data.canonical.state === 'not_suppressed' ? 'No canonical veto at last check' : 'Unavailable — no cached positive may authorize sending'}</dd></div>
        <div><dt className="text-muted-foreground">Review</dt><dd>{data.review ? 'Review required — excluded' : 'Not flagged'}</dd></div>
        <div><dt className="text-muted-foreground">Consent evidence recorded</dt><dd>{data.consentEvidencePresent ? 'Present — not a new consent grant' : 'Absent'}</dd></div>
      </dl>
      <p>Canonical checked: {data.canonical.checkedAt ? new Date(data.canonical.checkedAt).toISOString() : 'Unavailable'}. Sending requires a fresh canonical eligibility check, not this snapshot.</p>
    </>}
    <button type="button" onClick={() => void mutate()} disabled={isValidating} className="rounded border px-3 py-2 disabled:opacity-60">{isValidating ? 'Checking suppression…' : 'Refresh suppression status'}</button>
  </section>;
}
