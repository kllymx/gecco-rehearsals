import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LabCommand, LabSnapshot } from '../shared/lab.js';
import { createApp } from '../server/app.js';
import { createLabManager, LabApiError, validateLabCommand, validateLabCreate, type LabManager, type LabWorker } from '../server/lab.js';

const snapshot = (): LabSnapshot => ({ id: randomUUID(), revision: 0, variant: 'breaking', phase: 'original', label: 'Max',
  createdAt: '2026-09-10T12:00:00Z', updatedAt: '2026-09-10T12:00:00Z', databaseId: randomUUID(), sourceDigest: 'test-source',
  fixtureDigest: 'test-fixture', columns: ['session_payload'], rows: [], selectedSessionId: 'test-row', events: [],
  allowedActions: ['read-old', 'migrate'], scope: 'API test double; no execution evidence.' });
const command = (): LabCommand => ({ commandId: randomUUID(), expectedRevision: 0, action: 'migrate' });

async function setup(lab: LabManager) {
  const directory = await mkdtemp(join(tmpdir(), 'gecco-lab-api-'));
  const app = createApp({ lab, runsDirectory: directory, specimen: () => { throw new Error('Unused'); },
    rehearse: async () => { throw new Error('Unused'); }, analysis: {
      health: async () => ({ available: false, provider: 'test', model: null }), analyze: async () => { throw new Error('Unused'); },
    } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  return { ...app, base: `http://127.0.0.1:${address.port}`, cleanup: async () => {
    app.abortAll(); app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const rejectsStatus = (status: number) => (error: unknown) => error instanceof LabApiError && error.statusCode === status;

test('lab input accepts trimmed Unicode labels and rejects arbitrary commands, SQL, controls, long labels and unsafe revisions', () => {
  assert.deepEqual(validateLabCreate({ variant: 'breaking', label: '  Héllo 🦎  ' }), { variant: 'breaking', label: 'Héllo 🦎' });
  for (const value of [{ variant: 'breaking', label: 'x'.repeat(49) }, { variant: 'breaking', label: 'x\ny' },
    { variant: 'breaking', label: 'x\u0085y' }, { variant: 'compatible', label: ' ' }, { variant: 'breaking', label: 'x', sql: 'DROP TABLE x' }]) {
    assert.throws(() => validateLabCreate(value), rejectsStatus(400));
  }
  const valid = command();
  assert.deepEqual(validateLabCommand(valid), valid);
  for (const value of [{ ...valid, action: 'execute-sql' }, { ...valid, expectedRevision: -1 },
    { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, expectedRevision: 1.5 },
    { ...valid, commandId: '../bad' }, { ...valid, sql: 'SELECT 1' }]) {
    assert.throws(() => validateLabCommand(value), rejectsStatus(400));
  }
});

test('lab HTTP routes validate before dispatch, pass command identity unchanged and return state/conflict/expiry/close statuses', async () => {
  const state = snapshot();
  let creates = 0, closes = 0;
  let accepted: LabCommand | undefined;
  const lab: LabManager = {
    create: async input => { creates++; assert.equal(input.label, 'Max'); return state; },
    snapshot: async id => { if (id !== state.id) throw new LabApiError(404, 'Expired'); return state; },
    execute: async (_id, next) => {
      if (next.expectedRevision !== 0) throw new LabApiError(409, 'Revision conflict');
      accepted = next; return { ...state, revision: 1 };
    },
    close: async () => { closes++; }, closeAll: () => {},
  };
  const app = await setup(lab);
  try {
    assert.equal((await post(app.base, '/api/lab', { variant: 'breaking', label: 'Max', sql: 'SELECT 1' })).status, 400);
    assert.equal((await post(app.base, '/api/lab', { variant: 'breaking', label: 'Max' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(app.base, '/api/lab', { variant: 'breaking', label: 'x'.repeat(2000) })).status, 413);
    assert.equal(creates, 0);
    const created = await post(app.base, '/api/lab', { variant: 'breaking', label: ' Max ' });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), state);
    assert.deepEqual(await (await fetch(`${app.base}/api/lab/${state.id}`)).json(), state);
    assert.equal((await fetch(`${app.base}/api/lab/${randomUUID()}`)).status, 404);
    const next = command();
    assert.equal((await post(app.base, `/api/lab/${state.id}/commands`, next)).status, 200);
    assert.deepEqual(accepted, next);
    assert.equal((await post(app.base, `/api/lab/${state.id}/commands`, { ...next, expectedRevision: 2 })).status, 409);
    assert.equal((await fetch(`${app.base}/api/lab/${state.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(closes, 1);
  } finally { await app.cleanup(); }
});

test('manager reserves all three capacity slots during startup, rejects a fourth, and frees closed sessions', async () => {
  const release: (() => void)[] = [];
  let stopped = 0;
  const manager = createLabManager({ workerFactory: () => ({ stop: () => { stopped++; }, request: async message => {
    if (message.op === 'close') return;
    await new Promise<void>(resolve => release.push(resolve));
    return snapshot();
  } }) });
  try {
    const pending = [1, 2, 3].map(() => manager.create({ variant: 'breaking', label: 'Max' }));
    await assert.rejects(manager.create({ variant: 'breaking', label: 'Max' }), rejectsStatus(429));
    release.forEach(resolve => resolve());
    const states = await Promise.all(pending);
    assert.equal(new Set(states.map(state => state.id)).size, 3);
    await manager.close(states[0].id);
    await assert.rejects(manager.snapshot(states[0].id), rejectsStatus(404));
    assert.equal(stopped, 1);
  } finally { manager.closeAll(); }
  assert.equal(stopped, 3);
});

test('manager rejects concurrent requests, keeps known conflicts usable, and invalidates uncertain replies', async () => {
  let release: (() => void) | undefined;
  let mode: 'hold' | 'conflict' | 'uncertain' = 'hold';
  let stopped = 0;
  const manager = createLabManager({ workerFactory: () => ({ stop: () => { stopped++; }, request: async message => {
    if (message.op === 'create') return snapshot();
    if (mode === 'conflict') throw new LabApiError(409, 'Wrong phase');
    if (mode === 'uncertain') throw new LabApiError(504, 'Timeout');
    await new Promise<void>(resolve => { release = resolve; });
    return snapshot();
  } }) });
  try {
    const state = await manager.create({ variant: 'breaking', label: 'Max' });
    const pending = manager.execute(state.id, command());
    await assert.rejects(manager.snapshot(state.id), rejectsStatus(409));
    await assert.rejects(manager.close(state.id), rejectsStatus(409));
    release!(); await pending;
    mode = 'conflict';
    await assert.rejects(manager.execute(state.id, command()), rejectsStatus(409));
    assert.equal(stopped, 0);
    mode = 'uncertain';
    await assert.rejects(manager.snapshot(state.id), rejectsStatus(504));
    assert.equal(stopped, 1);
    await assert.rejects(manager.snapshot(state.id), rejectsStatus(404));
  } finally { manager.closeAll(); }
});

test('manager expires idle and maximum-lifetime sessions and shutdown kills owned workers', async () => {
  let time = 0, stopped = 0;
  const factory = (): LabWorker => ({ stop: () => { stopped++; }, request: async () => snapshot() });
  const manager = createLabManager({ now: () => time, idleTtlMs: 100, maxLifetimeMs: 250, workerFactory: factory });
  try {
    const first = await manager.create({ variant: 'breaking', label: 'Max' });
    time = 100;
    await assert.rejects(manager.snapshot(first.id), rejectsStatus(404));
    const second = await manager.create({ variant: 'breaking', label: 'Max' });
    time = 180; await manager.snapshot(second.id);
    time = 260; await manager.snapshot(second.id);
    time = 340; await manager.snapshot(second.id);
    time = 350; await assert.rejects(manager.snapshot(second.id), rejectsStatus(404));
    await manager.create({ variant: 'compatible', label: 'Max' });
    assert.equal(stopped, 2);
  } finally { manager.closeAll(); }
  assert.equal(stopped, 3);
});

test('real worker startup deadline terminates and removes the session', async () => {
  const manager = createLabManager({ requestTimeoutMs: 1 });
  try {
    // More requests than the capacity verifies each failed startup released its slot.
    for (let i = 0; i < 4; i++) await assert.rejects(manager.create({ variant: 'breaking', label: 'Max' }), rejectsStatus(504));
  } finally { manager.closeAll(); }
});

test('HTTP disconnect cancels the lab request signal without converting it into an execution result', async () => {
  let started!: () => void, cancelled!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  const didCancel = new Promise<void>(resolve => { cancelled = resolve; });
  const app = await setup({
    create: async (_input, signal) => {
      started();
      return new Promise<LabSnapshot>((_resolve, reject) => signal?.addEventListener('abort', () => {
        cancelled(); reject(new LabApiError(503, 'Cancelled and closed'));
      }, { once: true }));
    },
    execute: async () => snapshot(), snapshot: async () => snapshot(), close: async () => {}, closeAll: () => {},
  });
  try {
    const controller = new AbortController();
    const pending = fetch(`${app.base}/api/lab`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variant: 'breaking', label: 'Max' }), signal: controller.signal }).catch(() => undefined);
    await didStart;
    controller.abort();
    await Promise.race([didCancel, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation missing')), 2000).unref())]);
    await pending;
  } finally { await app.cleanup(); }
});

test('actual worker keeps the database across commands, replays command IDs once, and closes on explicit deletion or cancellation', async () => {
  const manager = createLabManager();
  try {
    const state = await manager.create({ variant: 'breaking', label: 'API worker test' });
    const migration = command();
    const migrated = await manager.execute(state.id, migration);
    assert.equal(migrated.databaseId, state.databaseId);
    assert.equal(migrated.phase, 'upgraded');
    assert.deepEqual(await manager.execute(state.id, migration), migrated);
    assert.equal((await manager.snapshot(state.id)).revision, 1);
    await assert.rejects(manager.execute(state.id, { ...migration, commandId: randomUUID() }), rejectsStatus(409));
    const observed = await manager.execute(state.id, { commandId: randomUUID(), expectedRevision: 1, action: 'read-old' });
    assert.equal(observed.events.at(-1)?.outcome, 'failed');
    assert.equal(observed.databaseId, state.databaseId);
    await manager.close(state.id);
    await assert.rejects(manager.snapshot(state.id), rejectsStatus(404));
    const next = await manager.create({ variant: 'compatible', label: 'Cancelled test' });
    const controller = new AbortController();
    const pending = manager.snapshot(next.id, controller.signal);
    controller.abort();
    await assert.rejects(pending, rejectsStatus(503));
    await assert.rejects(manager.snapshot(next.id), rejectsStatus(404));
  } finally { manager.closeAll(); }
});
