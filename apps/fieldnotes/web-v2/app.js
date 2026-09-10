const $ = id => document.getElementById(id);
const pendingKey = 'fieldnotes-launch-board-pending:v1';
let state = null;
let tab = 'board';
let confirmedNote = '';
let sending = false;
let dirty = false;
let adding = false;
let pending = null;
let networkError = '';
let saveMessage = '';
let pollRequest = null;
let lastWorkspaceRead = 0;
let renderedTasks = '';
try {
  const restored = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
  if (restored && typeof restored.commandId === 'string' && typeof restored.note === 'string' && [...restored.note].length <= 280) pending = { commandId: restored.commandId, note: restored.note };
} catch { /* Retry persistence is optional. */ }

function remember() {
  try {
    if (pending) sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The current tab still retains the exact pending command. */ }
}
async function api(path, input) {
  const response = await fetch(`.${path}`, input === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : 'The application request failed.'), { status: response.status });
  return data;
}
// Keep the exact note bytes around each marker, including non-task lines and CRLF.
function tasksFrom(note) {
  const tasks = [];
  const pattern = /^([\t ]*- \[)([ xX])(\][\t ]+)([^\r\n]+)/gm;
  for (const match of note.matchAll(pattern)) tasks.push({
    marker: match.index + match[1].length,
    checked: match[2].toLowerCase() === 'x',
    label: match[4],
  });
  return tasks;
}
function accept(next) {
  if (state?.instanceId === next.instanceId && next.revision < state.revision) return;
  state = next;
  if (!sending && !dirty && !pending && next.observation?.outcome === 'passed') {
    const note = next.observation.note ?? '';
    if (note !== confirmedNote) saveMessage = '';
    confirmedNote = note;
  }
  render();
}
function renderTasks() {
  const tasks = tasksFrom(confirmedNote);
  const complete = tasks.filter(task => task.checked).length;
  $('progress-label').textContent = tasks.length ? `${complete} of ${tasks.length} ready for launch` : 'Your first task starts the board';
  $('progress').max = Math.max(tasks.length, 1);
  $('progress').value = complete;
  $('progress').setAttribute('aria-valuetext', `${complete} of ${tasks.length} tasks completed`);
  $('no-tasks').hidden = tasks.length > 0;
  if (renderedTasks !== confirmedNote) {
    const focusedMarker = document.activeElement?.dataset?.marker;
    $('tasks').replaceChildren(...tasks.map((task, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `board-task${task.checked ? ' complete' : ''}`;
      button.dataset.marker = String(task.marker);
      button.setAttribute('role', 'checkbox'); button.setAttribute('aria-checked', String(task.checked));
      button.setAttribute('aria-label', task.label);
      const check = document.createElement('span'); check.className = 'board-task-check'; check.setAttribute('aria-hidden', 'true'); check.textContent = task.checked ? '✓' : '';
      const text = document.createElement('span'); text.className = 'board-task-label'; text.textContent = task.label;
      const status = document.createElement('span'); status.className = 'board-task-state'; status.setAttribute('aria-hidden', 'true'); status.textContent = task.checked ? 'Done' : String(index + 1).padStart(2, '0');
      button.append(check, text, status);
      button.addEventListener('click', () => { void toggle(task); });
      return button;
    }));
    renderedTasks = confirmedNote;
    if (focusedMarker) [...$('tasks').children].find(button => button.dataset.marker === focusedMarker)?.focus();
  }
  for (const button of $('tasks').children) button.disabled = Boolean(sending || pending || dirty || state?.autonomous || state?.observation?.outcome !== 'passed');
  $('stored-note').textContent = confirmedNote || '(Empty note)';
}
function render() {
  const observed = state?.observation;
  const ready = observed?.outcome === 'passed';
  const failed = observed?.outcome === 'failed';
  $('board-tab').setAttribute('aria-current', tab === 'board' ? 'page' : 'false');
  $('session-tab').setAttribute('aria-current', tab === 'session' ? 'page' : 'false');
  $('board').hidden = !ready || tab !== 'board';
  $('session').hidden = !ready || tab !== 'session';
  $('unavailable').hidden = Boolean(ready);
  $('network').hidden = !networkError && (!pending || sending);
  $('network-message').textContent = networkError || 'This save has no confirmed response. Retry the same save to recover its result.';
  $('retry-save').hidden = !pending;
  $('retry-save').disabled = Boolean(sending || state?.autonomous);
  $('connection').textContent = ready ? 'Board connected' : failed ? 'Session unavailable' : observed ? 'Read incomplete' : 'Opening board';
  $('connection').classList.toggle('ok', ready);
  $('release').textContent = state?.release || 'Loading…';
  $('sync-state').textContent = state?.autonomous ? 'REHEARSAL IN PROGRESS' : pending ? 'Waiting for save confirmation' : dirty ? 'Updates paused while editing' : sending ? 'Reading or saving…' : 'Updates every 3s';
  $('refresh').disabled = Boolean(sending || dirty || pending);
  $('open').disabled = Boolean(sending || pending);
  $('add-toggle').disabled = Boolean(!ready || sending || pending || state?.autonomous);
  $('add-toggle').setAttribute('aria-expanded', String(adding));
  $('add-form').hidden = !adding;
  $('new-task').disabled = Boolean(sending || pending || state?.autonomous);
  $('add-submit').disabled = Boolean(!ready || sending || pending || state?.autonomous || !$('new-task').value.trim());
  $('add-cancel').disabled = Boolean(sending || pending);
  $('save-state').textContent = sending ? pending ? 'Saving…' : 'Reading…' : pending ? 'Save unconfirmed' : dirty ? 'New task draft' : saveMessage || 'Stored in your launch note';
  $('edit-hint').textContent = state?.autonomous ? 'Pause the rehearsal to make changes.' : dirty ? 'Add or cancel your draft first.' : 'Click a task to save its progress.';
  if (ready) {
    $('welcome').textContent = `${observed.userId}, one step closer to shipping.`;
    $('avatar').textContent = [...(observed.userId || '')][0]?.toUpperCase() || '';
    for (const [element, value] of [['session-user', observed.userId], ['session-role', observed.role], ['session-id', observed.sessionId], ['session-marker', observed.writeMarker], ['database-id', observed.databaseId], ['instance-id', observed.instanceId]]) $(element).textContent = value ?? 'Not observed';
  } else {
    $('unavailable').classList.toggle('failed', Boolean(failed));
    $('empty-label').textContent = failed ? 'SESSION COULD NOT BE RESTORED' : 'OPENING YOUR BOARD';
    $('empty-title').textContent = failed ? 'Your launch board is out of reach.' : observed ? 'The board needs another try.' : 'Your next launch starts here.';
    $('empty-description').textContent = failed ? 'This release could not read the stored session. Your launch tasks stay unavailable until access is restored.' : observed ? 'The app could not establish a database result. Try opening the board again.' : 'Reading your session and launch checklist from the workspace database.';
    $('failure').hidden = !observed?.error;
    $('failure').textContent = observed?.error?.cause || '';
  }
  renderTasks();
}
async function readWorkspace() {
  if (sending || dirty || pending) return;
  sending = true; render();
  await pollRequest?.catch(() => undefined);
  try {
    const result = await api('/api/workspace');
    if (result.outcome === 'passed') confirmedNote = result.snapshot.observation?.note ?? '';
    accept(result.snapshot); lastWorkspaceRead = Date.now(); networkError = '';
  } catch (error) { networkError = error.message; }
  finally { sending = false; render(); }
}
async function submitPending() {
  if (!pending || sending || state?.autonomous) return;
  sending = true; remember(); render();
  await pollRequest?.catch(() => undefined);
  try {
    const result = await api('/api/note', pending);
    pending = null; remember();
    if (result.outcome === 'passed') {
      confirmedNote = result.snapshot.observation?.note ?? '';
      dirty = false; adding = false; $('new-task').value = ''; saveMessage = 'Saved to database';
    } else saveMessage = 'Save did not complete';
    accept(result.snapshot); networkError = '';
  } catch (error) {
    networkError = error.message;
    if (error.status >= 400 && error.status < 500) { pending = null; remember(); }
  } finally { sending = false; render(); }
}
function queueNote(note) {
  if ([...note].length > 280) { networkError = 'Your launch note can hold 280 characters. Shorten the task before adding it.'; render(); return; }
  pending = { commandId: crypto.randomUUID(), note }; saveMessage = '';
  void submitPending();
}
async function toggle(task) {
  if (sending || pending || dirty || state?.autonomous || state?.observation?.outcome !== 'passed') return;
  const marker = confirmedNote[task.marker];
  if (![' ', 'x', 'X'].includes(marker)) return;
  queueNote(confirmedNote.slice(0, task.marker) + (task.checked ? ' ' : 'x') + confirmedNote.slice(task.marker + 1));
}
async function addTask(event) {
  event.preventDefault();
  if (sending || pending || state?.autonomous || state?.observation?.outcome !== 'passed') return;
  const text = $('new-task').value.trim().replace(/[\r\n]+/g, ' ');
  if (!text) return;
  // A draft pauses synchronization, so reread the actual note before appending.
  sending = true; render();
  await pollRequest?.catch(() => undefined);
  let currentNote;
  try {
    const result = await api('/api/workspace'); accept(result.snapshot);
    if (result.outcome !== 'passed') return;
    currentNote = result.snapshot.observation?.note ?? '';
  } catch (error) { networkError = error.message; return; }
  finally { sending = false; render(); }
  const newline = currentNote.includes('\r\n') ? '\r\n' : '\n';
  const separator = currentNote && !currentNote.endsWith('\n') ? newline : '';
  queueNote(`${currentNote}${separator}- [ ] ${text}`);
}
$('add-toggle').addEventListener('click', () => { adding = !adding; if (!adding) { dirty = false; $('new-task').value = ''; } render(); if (adding) $('new-task').focus(); });
$('new-task').addEventListener('input', () => { dirty = Boolean($('new-task').value); render(); });
$('add-form').addEventListener('submit', event => { void addTask(event); });
$('add-cancel').addEventListener('click', () => { adding = false; dirty = false; $('new-task').value = ''; networkError = ''; render(); void readWorkspace(); });
$('retry-save').addEventListener('click', () => { void submitPending(); });
for (const button of ['refresh', 'open']) $(button).addEventListener('click', () => { void readWorkspace(); });
for (const selected of ['board', 'session']) $(`${selected}-tab`).addEventListener('click', () => { tab = selected; render(); });
document.querySelector('.board-brand').addEventListener('click', event => { event.preventDefault(); tab = 'board'; render(); });
async function poll() {
  try {
    if (!sending) {
      pollRequest = api('/api/state');
      const next = await pollRequest;
      pollRequest = null;
      const changedProcess = state && state.instanceId !== next.instanceId;
      accept(next);
      if (!sending && !dirty && !pending && !next.autonomous && (changedProcess || Date.now() - lastWorkspaceRead >= 3000)) await readWorkspace();
    }
  } catch (error) { networkError = error.message; render(); }
  finally { pollRequest = null; setTimeout(poll, 1000); }
}
render();
await readWorkspace();
void poll();
