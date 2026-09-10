import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TwinCommand, TwinSide, TwinSnapshot } from '../shared/twin';
import './preview.css';

class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new RequestError(body.error || `Request failed (${response.status}).`, response.status);
  return body as T;
}
const query = new URLSearchParams(location.search);
const experiment = query.get('experiment');
const side: TwinSide = query.get('side') === 'right' ? 'right' : 'left';
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storageKey = `gecco:twin-preview:${experiment}:${side}`;
function readPending(): TwinCommand | null {
  try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { return null; }
}
function remember(command: TwinCommand | null) {
  try { if (command) sessionStorage.setItem(storageKey, JSON.stringify(command)); else sessionStorage.removeItem(storageKey); } catch { /* Optional reload recovery. */ }
}
function Mark({ kind }: { kind: 'note' | 'check' | 'refresh' | 'lock' }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'note' ? <><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h5"/></> : kind === 'check' ? <path d="m5 12 4 4L19 6"/> : kind === 'refresh' ? <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6"/> : <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>}
  </svg>;
}
function PreviewApp() {
  const [state, setState] = useState<TwinSnapshot | null>(null);
  const [error, setError] = useState<string | null>(() => readPending() ? 'The previous action has no confirmed response. Retry to recover its result.' : null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState<TwinCommand | null>(readPending);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'workspace' | 'session'>('workspace');
  const latest = useRef<TwinSnapshot | null>(null);
  const lock = useRef(false);
  const inFlight = useRef<Promise<TwinSnapshot> | null>(null);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(pending);
  function accept(next: TwinSnapshot) {
    if (latest.current && latest.current.revision > next.revision) return;
    latest.current = next;
    setState(next);
    if (!pendingRef.current) setError(null);
    const observed = next.apps[side].observation;
    const outstanding = pendingRef.current;
    if (outstanding && next.events.some(event => event.id === outstanding.commandId)) {
      const event = next.events.find(event => event.id === outstanding.commandId)!;
      if (outstanding.action.startsWith('save-') && event.outcome === 'passed') {
        dirtyRef.current = false; setDirty(false);
      }
      pendingRef.current = null; setPending(null); remember(null);
    }
    if (!dirtyRef.current && observed?.note !== undefined && !next.apps[side].stale) setDraft(observed.note);
  }
  useEffect(() => {
    if (!experiment || !validId.test(experiment)) { setError('Open this preview from a release rehearsal.'); return; }
    let live = true;
    let terminal = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const request = inFlight.current ||= api<TwinSnapshot>(`/api/twins/${experiment}`);
        let next: TwinSnapshot;
        try { next = await request; } finally { if (inFlight.current === request) inFlight.current = null; }
        if (live) accept(next);
      } catch (reason) {
        if (live) {
          setError(reason instanceof Error ? reason.message : 'The app could not reach its runtime.');
          if (reason instanceof RequestError && reason.status === 404) { setExpired(true); terminal = true; return; }
        }
      } finally { if (live && !terminal) timer = setTimeout(poll, 900); }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  const app = state?.apps[side];
  const observed = app?.observation;
  const current = Boolean(observed && !app?.stale);
  const running = state?.automation.status === 'running';
  const disabled = Boolean(!state || state.busy || running || sending || expired || pending);
  const authenticated = current && observed?.outcome === 'passed';
  const failed = current && observed?.outcome === 'failed';
  const actionRead = side === 'left' ? 'read-left' : 'read-right';
  const actionSave = side === 'left' ? 'save-left' : 'save-right';
  async function execute(action: TwinCommand['action'], retry?: TwinCommand) {
    const currentState = latest.current;
    if (!currentState || lock.current || expired || currentState.automation.status === 'running') return;
    const command = retry || { commandId: crypto.randomUUID(), expectedRevision: currentState.revision, action, ...(action.startsWith('save-') ? { note: draft } : {}) };
    lock.current = true; setSending(true); setError(null);
    pendingRef.current = command; setPending(command); remember(command);
    try {
      const next = await api<TwinSnapshot>(`/api/twins/${experiment}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
      accept(next);
      if (pendingRef.current?.commandId === command.commandId) { pendingRef.current = null; setPending(null); remember(null); }
    } catch (reason) {
      if (reason instanceof RequestError && reason.status >= 400 && reason.status < 500) {
        pendingRef.current = null; setPending(null); remember(null);
        if (reason.status === 404) setExpired(true);
      }
      setError(reason instanceof Error ? reason.message : 'No confirmed response. Retry to recover this exact action.');
    } finally { lock.current = false; setSending(false); }
  }
  const actor = observed?.userId || state?.label || 'Your team';
  return <div className="specimen-app">
    <header className="specimen-header"><a href="#workspace" onClick={(event) => { event.preventDefault(); setTab('workspace'); }} className="specimen-brand"><span><Mark kind="note"/></span>fieldnotes<span className="specimen-brand-dot">.</span></a><span className={`specimen-connection ${authenticated ? 'ok' : ''}`}>{running ? 'Gecco is testing' : authenticated ? 'Workspace connected' : failed ? 'Session unavailable' : 'Waiting for a read'}</span></header>
    <nav className="specimen-nav" aria-label="Preview app"><button aria-current={tab === 'workspace' ? 'page' : undefined} onClick={() => setTab('workspace')}>Workspace</button><button aria-current={tab === 'session' ? 'page' : undefined} onClick={() => setTab('session')}>Session</button><span>{app?.release || 'App'}</span></nav>
    {error ? <div className="specimen-network" role="alert">{error}{pending && !running ? <button onClick={() => execute(pending.action, pending)} disabled={sending}>Retry last action</button> : null}</div> : null}
    <main className="specimen-main">
      {authenticated ? <>
        <div className="specimen-welcome"><div><span className="specimen-overline">TEAM WORKSPACE</span><h1>Welcome back, {actor}.</h1><p>Your session opened the workspace.</p></div><span className="specimen-avatar" aria-hidden="true">{actor.slice(0, 1).toUpperCase()}</span></div>
        {tab === 'workspace' ? <section className="specimen-note"><div className="specimen-note-title"><span><Mark kind="note"/>Launch note</span><span>{dirty ? 'Unsaved changes' : 'Stored in database'}</span></div><label htmlFor="workspace-note" className="sr-only">Launch note</label><textarea id="workspace-note" value={draft} maxLength={280} disabled={disabled} onChange={(event) => { dirtyRef.current = true; setDirty(true); setDraft(event.target.value); }}/><div className="specimen-note-footer"><span>{running ? 'Pause the rehearsal to edit this app.' : 'Saving checks your session first.'}</span><button className="specimen-save" onClick={() => execute(actionSave)} disabled={disabled || !state?.allowedActions.includes(actionSave)}>{sending ? 'Saving…' : 'Save note'}<Mark kind="check"/></button></div></section> : <section className="specimen-session"><h2>Current session</h2><dl><dt>User</dt><dd>{observed?.userId}</dd><dt>Role</dt><dd>{observed?.role}</dd><dt>Record</dt><dd>{observed?.sessionId}</dd><dt>Write marker</dt><dd>{observed?.writeMarker}</dd></dl></section>}
      </> : <section className={`specimen-empty ${failed ? 'failed' : ''}`}><span className="specimen-empty-icon"><Mark kind={failed ? 'lock' : 'refresh'}/></span><span className="specimen-overline">{failed ? 'SESSION COULD NOT BE RESTORED' : app?.stale ? 'DATABASE CHANGED' : 'OPENING THE WORKSPACE'}</span><h1>{failed ? 'Your workspace is out of reach.' : app?.stale ? 'Can this app still get in?' : 'A real session. A real workspace.'}</h1><p>{failed ? 'The application could not read its session. The workspace and note are unavailable until that read succeeds.' : app?.stale ? 'The last response belongs to an earlier database state. Run a fresh request to see what works now.' : 'Gecco will open this app using the session stored in its database.'}</p>{failed ? <div className="specimen-failure-reason">{observed?.error?.includes('42703') ? 'The session column this version needs is missing.' : 'The stored session format does not match this version.'}</div> : null}<button className="specimen-retry" disabled={disabled || !state?.allowedActions.includes(actionRead)} onClick={() => execute(actionRead)}><Mark kind="refresh"/>{failed ? 'Try opening workspace' : 'Open workspace'}</button></section>}
    </main>
    <footer className="specimen-footer"><span>{running ? 'AUTONOMOUS REHEARSAL' : 'INTERACTIVE APP PREVIEW'}</span><button onClick={() => execute(actionRead)} disabled={disabled || !state?.allowedActions.includes(actionRead)}><Mark kind="refresh"/>Refresh workspace</button></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><PreviewApp/></StrictMode>);
