const $ = id => document.getElementById(id);
let state = null;
let tab = 'workspace';
let sending = false;
let dirty = false;
let pending = null;
let networkError = '';
try { pending = JSON.parse(sessionStorage.getItem('fieldnotes-pending-save') || 'null'); } catch { /* Optional retry persistence. */ }
function remember() { try { if (pending) sessionStorage.setItem('fieldnotes-pending-save', JSON.stringify(pending)); else sessionStorage.removeItem('fieldnotes-pending-save'); } catch {} }
async function api(path, input) {
  const response = await fetch(`.${path}`, input === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'The application request failed.'), { status: response.status });
  return data;
}
function accept(next) {
  if (state?.instanceId === next.instanceId && next.revision < state.revision) return;
  state = next;
  if (!dirty && !pending && next.observation?.outcome === 'passed') $('note').value = next.observation.note ?? '';
  render();
}
function render() {
  const observed = state?.observation;
  const ready = observed?.outcome === 'passed';
  const failed = observed?.outcome === 'failed';
  $('workspace-tab').setAttribute('aria-current', tab === 'workspace' ? 'page' : 'false');
  $('session-tab').setAttribute('aria-current', tab === 'session' ? 'page' : 'false');
  $('workspace').hidden = !ready || tab !== 'workspace';
  $('session').hidden = !ready || tab !== 'session';
  $('unavailable').hidden = Boolean(ready);
  $('network').hidden = !networkError && !pending;
  $('network-message').textContent = networkError || 'The previous save has no confirmed response. Retry to recover its result.';
  $('retry-save').hidden = !pending;
  $('retry-save').disabled = sending;
  $('connection').textContent = ready ? 'Workspace connected' : failed ? 'Session unavailable' : observed ? 'Runtime unavailable' : 'Opening workspace';
  $('connection').classList.toggle('ok', ready);
  $('release').textContent = state?.release || 'Loading…';
  $('mode').textContent = state?.autonomous ? 'AUTONOMOUS REHEARSAL' : 'FIELDNOTES WORKSPACE';
  $('note').disabled = Boolean(sending || state?.autonomous || pending);
  $('save').disabled = Boolean(!ready || sending || state?.autonomous || pending);
  $('refresh').disabled = sending;
  $('open').disabled = sending;
  $('save-state').textContent = dirty ? 'Unsaved changes' : 'Stored in database';
  $('save-hint').textContent = state?.autonomous ? 'Pause the rehearsal to edit this app.' : 'Saving checks your session first.';
  if (ready) {
    $('welcome').textContent = `Welcome back, ${observed.userId}.`;
    $('avatar').textContent = [...observed.userId][0]?.toUpperCase() || '';
    for (const [element, value] of [['session-user', observed.userId], ['session-role', observed.role], ['session-id', observed.sessionId], ['session-marker', observed.writeMarker], ['database-id', observed.databaseId], ['instance-id', observed.instanceId]]) $(element).textContent = value;
  } else {
    $('unavailable').classList.toggle('failed', Boolean(failed));
    $('empty-label').textContent = failed ? 'SESSION COULD NOT BE RESTORED' : 'OPENING THE WORKSPACE';
    $('empty-title').textContent = failed ? 'Your workspace is out of reach.' : observed ? 'The app needs another try.' : 'Your notes, together.';
    $('empty-description').textContent = failed ? 'This release could not read the stored session. The note stays unavailable until the session can be restored.' : observed ? 'The application could not establish a database result. Try opening the workspace again.' : 'Open your workspace using its stored session.';
    $('failure').hidden = !observed?.error;
    $('failure').textContent = observed?.error?.cause || '';
  }
}
async function read() {
  if (sending) return; sending = true; render();
  try { accept((await api('/api/workspace')).snapshot); networkError = ''; }
  catch (error) { networkError = error.message; }
  finally { sending = false; render(); }
}
async function save(retry = false) {
  if (sending || !state || (state.autonomous && !retry)) return;
  if (!retry) {
    if ([...$('note').value].length > 280) { networkError = 'Keep the note to 280 characters.'; render(); return; }
    pending = { commandId: crypto.randomUUID(), note: $('note').value };
  }
  if (!pending) return;
  sending = true; remember(); render();
  try {
    const result = await api('/api/note', pending);
    pending = null; remember();
    if (result.outcome === 'passed') dirty = false;
    accept(result.snapshot); networkError = '';
  } catch (error) {
    networkError = error.message;
    if (error.status >= 400 && error.status < 500) { pending = null; remember(); }
  } finally { sending = false; render(); }
}
$('note').addEventListener('input', () => { dirty = true; render(); });
$('note-form').addEventListener('submit', event => { event.preventDefault(); void save(); });
$('retry-save').addEventListener('click', () => { void save(true); });
for (const button of ['refresh', 'open']) $(button).addEventListener('click', () => { void read(); });
for (const selected of ['workspace', 'session']) $(`${selected}-tab`).addEventListener('click', () => { tab = selected; render(); });
document.querySelector('.specimen-brand').addEventListener('click', event => { event.preventDefault(); tab = 'workspace'; render(); });
async function poll() {
  try {
    if (!sending) {
      const next = await api('/api/state');
      const changedProcess = state && state.instanceId !== next.instanceId;
      accept(next);
      if ((changedProcess || !next.observation) && !sending) await read();
    }
  } catch (error) { networkError = error.message; render(); }
  finally { setTimeout(poll, 1500); }
}
render();
await read();
void poll();
