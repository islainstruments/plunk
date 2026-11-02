/* ISLA dedicated non-sending staff editor — AGPL-3.0. No upstream dashboard routes. */
import type {Staff} from './StaffBoundary.js';

export const editorPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'";

export function newsletterEditorPage(staff: Staff): string {
  // Only a closed enum is interpolated; draft content never enters this HTML.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staff newsletters</title><link rel="stylesheet" href="/staff/newsletters/editor.css"><script src="/staff/newsletters/editor.js" defer></script></head>
<body data-role="${staff.role}"><header><h1>Staff newsletters</h1><p>Draft-only commissioning · All sending and customer dispatch disabled</p><p id="permission"></p></header>
<main><aside aria-label="Draft library"><h2>Saved drafts</h2><button id="new" type="button" hidden>New draft</button> <button id="refresh" type="button">Refresh list</button><ul id="drafts"></ul><button id="more" type="button" hidden>Load more</button></aside>
<section aria-label="Draft editor"><h2 id="heading">Select a draft</h2><p id="status" role="status" aria-live="polite">Loading drafts…</p>
<form id="editor"><fieldset id="fields" disabled><label for="subject">Subject</label><input id="subject" name="subject" maxlength="300" required><label for="html">HTML source</label><textarea id="html" name="html" rows="12" maxlength="200000" required spellcheck="false"></textarea><label for="text">Independent plain text</label><textarea id="text" name="text" rows="8" maxlength="100000" required></textarea></fieldset><button id="save" type="submit" hidden>Save draft</button> <button id="reload" type="button" disabled>Reload saved revision</button> <button id="copy" type="button" hidden>Copy to new draft</button></form>
<section id="conflict" hidden aria-label="Revision conflict"><h3>Revision conflict — your work has not been discarded</h3><p>Compare the latest saved version below. Copy any local changes before explicitly loading it. Saving again will not overwrite the newer revision.</p><pre id="latest"></pre><button id="accept" type="button">Load latest and discard local changes</button></section>
<h2>Saved preview (not sent)</h2><p>Preview shows the saved revision only. HTML is sanitized and sandboxed. External images and links are blocked to prevent tracking; image markup and alt text are preserved, not fetched. Plain text is never generated from HTML.</p><button id="preview" type="button" disabled>Refresh saved preview</button><iframe id="html-preview" title="Saved HTML preview" sandbox referrerpolicy="no-referrer"></iframe><h3>Saved plain text</h3><pre id="text-preview"></pre>
</section></main><footer>ISLA modifications · Plunk AGPL-3.0 · <a href="https://github.com/islainstruments/plunk/tree/isla/resend-staff" rel="noreferrer">Complete corresponding source and build instructions</a></footer></body></html>`;
}

export const editorStyles = `:root{font-family:system-ui,sans-serif;color:#172b3a;background:#f4f7fa}body{margin:0}header,footer{padding:1.2rem 2rem;background:#123447;color:white}header h1{margin:0}footer a{color:#b6edff}main{display:grid;grid-template-columns:minmax(210px,1fr) minmax(0,3fr);gap:1.5rem;padding:1.5rem}aside,main>section{background:white;border:1px solid #cfdae2;border-radius:8px;padding:1.2rem}label{display:block;font-weight:600;margin:.8rem 0 .3rem}fieldset{border:0;padding:0;margin:0}input,textarea{box-sizing:border-box;width:100%;padding:.65rem;border:1px solid #879bab;border-radius:4px;font:inherit}textarea{font-family:ui-monospace,monospace}button{cursor:pointer;border:1px solid #567182;border-radius:4px;background:#edf5f9;color:#123447;padding:.55rem .75rem;margin:.3rem .2rem .3rem 0}button:disabled{cursor:default;opacity:.6}button:focus-visible,a:focus-visible{outline:3px solid #1688b8}ul{padding:0;list-style:none}li button{text-align:left;width:100%;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f8;padding:1rem}iframe{display:block;width:100%;min-height:280px;border:1px solid #879bab;background:white;margin-top:.7rem}#status{padding:.7rem;background:#edf5f9}#conflict{border:2px solid #a9510d;padding:1rem;margin:1rem 0}[hidden]{display:none!important}@media(max-width:760px){main{grid-template-columns:1fr;padding:.7rem}header,footer{padding:1rem}}`;

// Compiled to ordinary browser JavaScript before being served. No bundler/Next runtime.
function editorClient() {
  type Content = {subject: string; html: string; text: string};
  type Draft = {id: string; revision: number; content: Content};
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const button = (id: string) => element<HTMLButtonElement>(id);
  const subject = element<HTMLInputElement>('subject');
  const html = element<HTMLTextAreaElement>('html');
  const text = element<HTMLTextAreaElement>('text');
  const status = element('status');
  const previewRevision = document.createElement('p');
  previewRevision.id = 'preview-revision';
  element('html-preview').before(previewRevision);
  const admin = document.body.dataset.role === 'admin';
  const base = '/staff/newsletters/api/drafts';
  let current: Draft | null = null;
  let latest: Draft | null = null;
  let dirty = false;
  let busy = false;
  let cursor: string | null = null;
  const content = (): Content => ({subject: subject.value, html: html.value, text: text.value});
  const message = (value: string) => { status.textContent = value; };
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(path, {method, credentials: 'same-origin', headers: body === undefined ? {} : {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store'});
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'Session unavailable. Return through the website staff login.' : response.status === 403 ? 'Write denied. An active admin and same-origin request are required.' : `Request failed (${response.status}). Local work is retained.`), {status: response.status});
    return response.json() as Promise<T>;
  }
  function controls() {
    element<HTMLFieldSetElement>('fields').disabled = !admin || busy;
    button('save').disabled = busy;
    button('new').disabled = busy;
    button('copy').disabled = busy || !current;
    button('reload').disabled = busy || !current;
    button('preview').disabled = busy || !current;
  }
  function show(draft: Draft | null, initial?: Content) {
    current = draft;
    latest = null;
    const value = draft?.content ?? initial ?? {subject: '', html: '', text: ''};
    subject.value = value.subject; html.value = value.html; text.value = value.text;
    dirty = Boolean(initial);
    element('heading').textContent = draft ? `Saved draft · revision ${draft.revision}` : 'New draft';
    element('conflict').hidden = true;
    element<HTMLIFrameElement>('html-preview').removeAttribute('src');
    element('text-preview').textContent = '';
    previewRevision.textContent = 'No saved preview loaded.';
    controls();
  }
  function mayDiscard() { return !dirty || window.confirm('Discard unsaved local changes?'); }
  async function preview() {
    if (!current) return;
    const saved = await api<Draft>(`${base}/${current.id}`);
    element('text-preview').textContent = saved.content.text;
    previewRevision.textContent = `Preview of saved revision ${saved.revision}; editor base revision ${current.revision}.`;
    element<HTMLIFrameElement>('html-preview').src = `${base}/${current.id}/preview?revision=${saved.revision}`;
  }
  async function open(id: string) {
    if (!mayDiscard()) return;
    const saved = await api<Draft>(`${base}/${id}`);
    show(saved);
    history.replaceState(null, '', `/staff/newsletters?draft=${saved.id}`);
    await preview();
    message(`Loaded revision ${saved.revision}. ${admin ? 'Changes are saved only when you choose Save draft.' : 'Read-only access.'}`);
  }
  async function list(append = false) {
    const page = await api<{drafts: {id: string; subject: string; revision: number}[]; next: string | null}>(base + (append && cursor ? `?after=${encodeURIComponent(cursor)}` : ''));
    const items = element('drafts');
    if (!append) items.replaceChildren();
    for (const draft of page.drafts) {
      const li = document.createElement('li');
      const link = document.createElement('button');
      link.type = 'button'; link.textContent = `${draft.subject} · r${draft.revision}`;
      link.addEventListener('click', () => void run(() => open(draft.id)));
      li.append(link); items.append(li);
    }
    cursor = page.next; button('more').hidden = !cursor;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true; controls();
    try { await action(); } catch (error) { message(error instanceof Error ? error.message : 'Draft service unavailable. Local work is retained.'); }
    finally { busy = false; controls(); }
  }
  element('permission').textContent = admin ? 'Active admin · draft editing enabled' : 'Active staff · read and preview only';
  for (const id of ['new', 'save', 'copy']) button(id).hidden = !admin;
  element('editor').addEventListener('input', () => { dirty = true; message('Unsaved local changes. Preview still shows saved content.'); });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  button('new').addEventListener('click', () => { if (mayDiscard()) { show(null); history.replaceState(null, '', '/staff/newsletters'); message('New draft. Enter subject, HTML and independent plain text.'); } });
  button('copy').addEventListener('click', () => { if (current) { const value = content(); show(null, value); history.replaceState(null, '', '/staff/newsletters'); message('Copied content to a new unsaved draft. Original draft is unchanged.'); } });
  button('refresh').addEventListener('click', () => void run(async () => { await list(); message('Draft list refreshed; local editor unchanged.'); }));
  button('more').addEventListener('click', () => void run(() => list(true)));
  button('reload').addEventListener('click', () => void run(async () => { if (current) await open(current.id); }));
  button('preview').addEventListener('click', () => void run(preview));
  button('accept').addEventListener('click', () => void run(async () => {
    if (latest && mayDiscard()) { show(latest); await preview(); message('Latest saved revision loaded.'); }
  }));
  element('editor').addEventListener('submit', event => {
    event.preventDefault();
    if (!admin) return;
    void run(async () => {
      let saved: Draft;
      try {
        saved = current ? await api<Draft>(`${base}/${current.id}`, 'PUT', {revision: current.revision, content: content()}) : await api<Draft>(base, 'POST', content());
      } catch (error) {
        if ((error as {status?: number}).status !== 409 || !current) throw error;
        latest = await api<Draft>(`${base}/${current.id}`);
        element('latest').textContent = `Latest saved revision ${latest.revision}\nSubject: ${latest.content.subject}\n\nHTML:\n${latest.content.html}\n\nPlain text:\n${latest.content.text}`;
        element('conflict').hidden = false;
        message('Conflict: another editor saved a newer revision. Your local HTML and plain text are retained.');
        return;
      }
      show(saved);
      history.replaceState(null, '', `/staff/newsletters?draft=${saved.id}`);
      await list(); await preview(); message(`Saved revision ${saved.revision}. No email queued or sent.`);
    });
  });
  void run(async () => {
    await list();
    const id = new URLSearchParams(location.search).get('draft');
    if (id && /^[0-9a-f-]{36}$/.test(id)) await open(id);
    else { controls(); message(admin ? 'Select a draft or create a new one.' : 'Select a saved draft to read and preview.'); }
  });
}

export function newsletterEditorScript(): string {
  return `(${editorClient.toString()})();`;
}
