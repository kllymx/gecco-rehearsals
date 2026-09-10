import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TWIN_JOURNEY, type TwinAction, type TwinCommand, type TwinSnapshot } from '../shared/twin.js';
import { createApp } from '../server/app.js';
import { createTwinManager, TwinApiError, validateTwinCommand, validateTwinControl, type TwinManager, type TwinWorker, type TwinWorkerRequest } from '../server/twins.js';

const allActions: TwinAction[] = ['read-both', 'read-left', 'read-right', 'save-left', 'save-right', 'deploy', 'write-new', 'rollback'];
const snapshot = (): TwinSnapshot => ({ id: randomUUID(), revision: 0, variant: 'breaking', label: 'Test', phase: 'baseline',
  createdAt: '2026-09-10T12:00:00Z', updatedAt: '2026-09-10T12:00:00Z', sourceDigest: 'test-source', fixtureDigest: 'test-fixture',
  apps: {
    left: { instanceId: randomUUID(), release: 'v1', databaseId: randomUUID(), sessionId: 'test-left', stale: false },
    right: { instanceId: randomUUID(), release: 'v1', databaseId: randomUUID(), sessionId: 'test-right', stale: false },
  }, databases: [], events: [], allowedActions: allActions, scope: 'Test fixture; no database execution.', busy: false,
  automation: { status: 'idle', stepIndex: 0, totalSteps: 8 } });
const command = (action: TwinAction = 'read-left', expectedRevision = 0): TwinCommand => ({ commandId: randomUUID(), expectedRevision, action });
const status = (code: number) => (error: unknown) => error instanceof TwinApiError && error.statusCode === code;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2));
async function until(predicate: () => Promise<boolean>, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error('Condition did not complete'); await tick(); }
}

function fakeWorker(options: { gate?: () => Promise<void>; actions?: TwinAction[]; stop?: () => void } = {}): TwinWorker {
  let state = snapshot();
  const accepted = new Map<string, TwinSnapshot>();
  return {
    stop: () => options.stop?.(),
    request: async (message: TwinWorkerRequest) => {
      if (message.op === 'close') return;
      if (message.op === 'create') return structuredClone(state);
      if (accepted.has(message.command.commandId)) return structuredClone(accepted.get(message.command.commandId));
      if (message.command.expectedRevision !== state.revision) throw new TwinApiError(409, 'Stale revision');
      await options.gate?.();
      options.actions?.push(message.command.action);
      state = { ...state, revision: state.revision + 1, events: [...state.events, {
        id: message.command.commandId, action: message.command.action, phase: state.phase, at: new Date().toISOString(), title: 'Test action',
        explanation: 'Test double', outcome: 'passed', durationMs: 1, observations: {}, sql: [],
      }] };
      accepted.set(message.command.commandId, structuredClone(state));
      return structuredClone(state);
    },
  };
}

async function setup(manager: TwinManager, distDirectory?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'gecco-twins-api-'));
  const app = createApp({ twins: manager, runsDirectory: directory, distDirectory,
    specimen: () => { throw new Error('Unused'); }, rehearse: async () => { throw new Error('Unused'); },
    analysis: { health: async () => ({ available: false, provider: 'test', model: null }), analyze: async () => { throw new Error('Unused'); } },
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}`, cleanup: async () => {
    app.abortAll(); app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('twin command/control validation permits bounded notes and rejects source, SQL, controls, invalid revisions and fields', () => {
  const valid = { ...command('save-left'), note: 'A note\nwith a tab\t🦎' };
  assert.deepEqual(validateTwinCommand(valid), valid);
  for (const input of [{ ...valid, sql: 'SELECT 1' }, { ...valid, note: 'x'.repeat(281) }, { ...valid, note: 'x\u0000' },
    { ...valid, action: 'run-code' }, { ...valid, expectedRevision: -1 }, { ...valid, action: 'read-left' }, command('save-left')]) {
    assert.throws(() => validateTwinCommand(input), status(400));
  }
  assert.equal(validateTwinControl({ action: 'play' }), 'play');
  assert.throws(() => validateTwinControl({ action: 'play', prompt: 'anything' }), status(400));
});

test('autonomous journey continues without requests, GET stays cached while busy, pause completes current action, and harmless manual work resumes', async () => {
  let release: (() => void) | undefined;
  let hold = true;
  const actions: TwinAction[] = [];
  const manager = createTwinManager({ dwellMs: 1, workerFactory: () => fakeWorker({ actions,
    gate: async () => { if (hold) await new Promise<void>(resolve => { release = resolve; }); },
  }) });
  try {
    const initial = await manager.create({ variant: 'breaking', label: 'Test' });
    const playing = await manager.control(initial.id, 'play');
    assert.equal(playing.busy, true);
    assert.equal(playing.automation.currentAction, 'read-both');
    const cached = await manager.snapshot(initial.id);
    assert.equal(cached.revision, 0);
    assert.equal(cached.busy, true);
    await assert.rejects(manager.execute(initial.id, command()), status(409));
    await manager.control(initial.id, 'pause');
    assert.equal((await manager.snapshot(initial.id)).automation.status, 'running');
    hold = false; release!();
    await until(async () => (await manager.snapshot(initial.id)).automation.status === 'paused');
    const paused = await manager.snapshot(initial.id);
    assert.equal(paused.automation.stepIndex, 1);
    const read = await manager.execute(initial.id, command('read-left', paused.revision));
    const saved = await manager.execute(initial.id, { ...command('save-left', read.revision), note: 'Explore paused app' });
    assert.equal(saved.automation.stepIndex, 1);
    assert.equal(saved.automation.status, 'paused');
    await manager.control(initial.id, 'play');
    await until(async () => (await manager.snapshot(initial.id)).automation.status === 'completed');
    assert.deepEqual(actions, [TWIN_JOURNEY[0], 'read-left', 'save-left', ...TWIN_JOURNEY.slice(1)]);
    assert.equal((await manager.snapshot(initial.id)).automation.stepIndex, 8);
  } finally { manager.closeAll(); }
});

test('manual structural changes cannot blindly resume and command retries never rewind cached state', async () => {
  const manager = createTwinManager({ workerFactory: () => fakeWorker() });
  try {
    const initial = await manager.create({ variant: 'breaking', label: 'Test' });
    const first = command('read-left');
    await manager.execute(initial.id, first);
    const second = await manager.execute(initial.id, command('read-right', 1));
    assert.equal((await manager.execute(initial.id, first)).revision, 1);
    assert.equal((await manager.snapshot(initial.id)).revision, second.revision);
    await manager.execute(initial.id, command('deploy', second.revision));
    await assert.rejects(manager.control(initial.id, 'play'), error => status(409)(error) && /Reset/.test((error as Error).message));
  } finally { manager.closeAll(); }
});

test('capacity includes starting coordinators, expiry removes sessions, and explicit close frees capacity', async () => {
  let time = 0, stopped = 0;
  const releases: (() => void)[] = [];
  const manager = createTwinManager({ now: () => time, idleTtlMs: 100, maxLifetimeMs: 250,
    workerFactory: () => ({ stop: () => { stopped++; }, request: async message => {
      if (message.op === 'create') { await new Promise<void>(resolve => releases.push(resolve)); return snapshot(); }
      return undefined;
    } }),
  });
  try {
    const pending = [1, 2].map(() => manager.create({ variant: 'breaking', label: 'Test' }));
    await assert.rejects(manager.create({ variant: 'breaking', label: 'Test' }), status(429));
    releases.forEach(resolve => resolve());
    const states = await Promise.all(pending);
    await manager.close(states[0].id);
    time = 100;
    await assert.rejects(manager.snapshot(states[1].id), status(404));
    assert.equal(stopped, 2);
  } finally { manager.closeAll(); }
});

test('maximum lifetime applies despite polling and closing during an action stops the worker', async () => {
  let time = 0, stopped = 0;
  let rejectPending: ((error: Error) => void) | undefined;
  const manager = createTwinManager({ now: () => time, idleTtlMs: 100, maxLifetimeMs: 250,
    workerFactory: () => ({
      stop: () => { stopped++; rejectPending?.(new TwinApiError(503, 'Closed')); },
      request: async message => message.op === 'create' ? snapshot()
        : new Promise<TwinSnapshot>((_resolve, reject) => { rejectPending = reject; }),
    }),
  });
  try {
    const state = await manager.create({ variant: 'breaking', label: 'Test' });
    time = 80; await manager.snapshot(state.id);
    time = 160; await manager.snapshot(state.id);
    time = 240; await manager.snapshot(state.id);
    time = 250; await assert.rejects(manager.snapshot(state.id), status(404));
    const next = await manager.create({ variant: 'breaking', label: 'Test' });
    await manager.control(next.id, 'play');
    assert.equal((await manager.snapshot(next.id)).busy, true);
    await manager.close(next.id);
    await assert.rejects(manager.snapshot(next.id), status(404));
    assert.equal(stopped, 2);
  } finally { manager.closeAll(); }
});

test('HTTP accepts only fixed inputs, supports previews, and play continues independently of the browser connection', async () => {
  const actions: TwinAction[] = [];
  const manager = createTwinManager({ dwellMs: 2, workerFactory: () => fakeWorker({ actions }) });
  const directory = await mkdtemp(join(tmpdir(), 'gecco-preview-test-'));
  await writeFile(join(directory, 'preview.html'), '<main>Preview</main>');
  await writeFile(join(directory, 'index.html'), '<main>App</main>');
  const app = await setup(manager, directory);
  try {
    assert.equal((await post(app.base, '/api/twins', { variant: 'breaking', label: 'Test', code: 'bad' })).status, 400);
    assert.equal((await post(app.base, '/api/twins', { variant: 'breaking', label: 'Test' }, { origin: 'https://evil.example' })).status, 403);
    const created = await post(app.base, '/api/twins', { variant: 'breaking', label: 'Test' });
    assert.equal(created.status, 201);
    const state = await created.json() as TwinSnapshot;
    assert.equal((await post(app.base, `/api/twins/${state.id}/control`, { action: 'play', sql: 'SELECT 1' })).status, 400);
    assert.equal((await post(app.base, `/api/twins/${state.id}/control`, { action: 'play' })).status, 200);
    await until(async () => (await manager.snapshot(state.id)).automation.status === 'completed');
    assert.deepEqual(actions, [...TWIN_JOURNEY]);
    const preview = await fetch(`${app.base}/preview.html`);
    assert(preview.headers.get('content-security-policy')?.includes("frame-ancestors 'self'"));
    const index = await fetch(app.base);
    assert(index.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.equal((await fetch(`${app.base}/api/twins/${state.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${app.base}/api/twins/${state.id}`)).status, 404);
  } finally { await app.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('real coordinator timeout releases its capacity instead of leaving an uncertain session', async () => {
  const manager = createTwinManager({ requestTimeoutMs: 1 });
  try {
    for (let index = 0; index < 3; index++) await assert.rejects(manager.create({ variant: 'breaking', label: 'Test' }), status(504));
  } finally { manager.closeAll(); }
});

test('disconnecting an accepted play request does not abort the server-owned journey', async () => {
  let started!: () => void, release!: () => void;
  const accepted = new Promise<void>(resolve => { started = resolve; });
  const holdResponse = new Promise<void>(resolve => { release = resolve; });
  const manager = createTwinManager({ dwellMs: 1, workerFactory: () => fakeWorker() });
  const app = await setup({ ...manager, control: async (id, action) => {
    const result = await manager.control(id, action); started(); await holdResponse; return result;
  } });
  try {
    const state = await manager.create({ variant: 'breaking', label: 'Test' });
    const controller = new AbortController();
    const pending = fetch(`${app.base}/api/twins/${state.id}/control`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'play' }), signal: controller.signal }).catch(() => undefined);
    await accepted; controller.abort(); await pending;
    await until(async () => (await manager.snapshot(state.id)).automation.status === 'completed');
    assert.equal((await manager.snapshot(state.id)).revision, TWIN_JOURNEY.length);
    release();
  } finally { release(); await app.cleanup(); }
});

test('actual coordinator completes the journey with two app processes, retained writes and cleanup', async () => {
  const manager = createTwinManager({ dwellMs: 1 });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const initial = await manager.create({ variant: 'breaking', label: 'Coordinator test' });
    const originalIds = Object.values(initial.apps).map(app => app.instanceId);
    assert.equal(new Set(originalIds).size, 2);
    assert.equal(new Set(initial.databases.map(db => db.id)).size, 2);
    const originalPids = originalIds.map(id => Number(id.split('-')[1]));
    assert(originalPids.every(pid => Number.isInteger(pid) && alive(pid)));
    await manager.control(initial.id, 'play');
    await until(async () => (await manager.snapshot(initial.id)).automation.status === 'completed', 20_000);
    const completed = await manager.snapshot(initial.id);
    assert.equal(completed.revision, 8);
    assert.equal(completed.phase, 'rollback');
    assert.deepEqual(completed.events.slice(1).map(event => event.action), [...TWIN_JOURNEY]);
    assert.equal(completed.events.at(-1)?.outcome, 'failed');
    assert(completed.databases.some(db => db.rows.length >= 3));
    const finalPids = Object.values(completed.apps).map(app => Number(app.instanceId.split('-')[1]));
    await manager.close(initial.id);
    await until(async () => [...originalPids, ...finalPids].every(pid => !alive(pid)), 3000);
    await assert.rejects(manager.snapshot(initial.id), status(404));
  } finally { manager.closeAll(); }
});
