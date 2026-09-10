import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createLabSession, LabError, type LabSession } from '../engine/lab.js';
import { getInputDigests } from '../engine/index.js';
import type { LabAction, LabCommand, LabCreateInput, LabSnapshot } from '../shared/lab.js';

async function act(session: LabSession, action: LabAction): Promise<LabSnapshot> {
  return session.execute({ commandId: randomUUID(), expectedRevision: (await session.snapshot()).revision, action });
}
function selected(snapshot: LabSnapshot): Record<string, unknown> {
  const row = snapshot.rows.find(row => row.id === snapshot.selectedSessionId);
  assert.ok(row, 'selected session must be present in the actual database rows');
  return row;
}

test('hands-on breaking lab preserves one database and the personalized marked write through rollback', async () => {
  const label = "Astra's demo; DROP TABLE sessions; --";
  const session = await createLabSession({ variant: 'breaking', label });
  try {
    const initial = await session.snapshot();
    assert.equal(initial.revision, 0);
    assert.equal(initial.events.length, 1);
    assert.equal(initial.events[0].outcome, 'passed');
    assert.equal((selected(initial).session_payload as Record<string, unknown>).userId, label);
    assert.ok(initial.events[0].sql.some(sql => sql.parameters?.some(value => String(value).includes(label))));
    assert.ok(initial.events[0].sql.every(sql => !sql.query.includes(label)), 'the user label must never be interpolated into SQL');
    assert.equal((await act(session, 'read-old')).events.at(-1)?.read?.userId, label);
    const migrated = await act(session, 'migrate');
    assert.equal(migrated.phase, 'upgraded');
    assert.deepEqual(migrated.columns, ['id', 'identity_payload']);
    const oldFailure = await act(session, 'read-old');
    assert.equal(oldFailure.events.at(-1)?.outcome, 'failed');
    assert.match(oldFailure.events.at(-1)?.read?.error ?? '', /42703/);
    assert.match(oldFailure.events.at(-1)?.explanation ?? '', /renamed that column/);
    const written = await act(session, 'write-new');
    const newId = written.newSessionId!;
    const beforeRollback = selected(written).identity_payload as Record<string, unknown>;
    assert.equal(written.selectedSessionId, newId);
    assert.notEqual(newId, initial.selectedSessionId);
    assert.equal((beforeRollback.principal as Record<string, unknown>).id, label);
    assert.equal((await act(session, 'read-new')).events.at(-1)?.read?.writeMarker, beforeRollback.writeMarker);
    const rolled = await act(session, 'rollback');
    assert.equal(rolled.databaseId, initial.databaseId);
    assert.equal(rolled.phase, 'rolled-back');
    assert.equal(rolled.selectedSessionId, newId);
    assert.deepEqual(rolled.columns, ['id', 'session_payload']);
    assert.deepEqual(selected(rolled).session_payload, beforeRollback);
    const readBack = await act(session, 'read-old');
    assert.equal(readBack.events.at(-1)?.outcome, 'failed');
    assert.match(readBack.events.at(-1)?.read?.error ?? '', /v1 requires flat/);
    assert.match(readBack.events.at(-1)?.explanation ?? '', /row is still present/);
    const query = readBack.events.at(-1)?.sql.find(sql => sql.query.startsWith('SELECT id, session_payload'));
    assert.equal(query?.rows?.[0]?.id, newId);
    assert.equal((query?.rows?.[0]?.session_payload as Record<string, unknown>).writeMarker, beforeRollback.writeMarker);
    assert.equal(readBack.revision, 7);
    assert.equal(readBack.rows.length, 3, 'seed, personalized v1 session and marked v2 session remain');
    assert.equal(readBack.events.filter(event => event.action === 'create').length, 1);
    assert.equal(readBack.sourceDigest, getInputDigests('breaking').sourceDigest);
    assert.equal(readBack.fixtureDigest, initial.fixtureDigest);
    assert.deepEqual(readBack.allowedActions, ['read-old']);
  } finally { await session.close(); }
});

test('compatible lab keeps personalized identity readable at each transition and retains the exact new marker', async () => {
  const session = await createLabSession({ variant: 'compatible', label: 'Hackathon user' });
  try {
    const initial = await session.snapshot();
    const snapshots: LabSnapshot[] = [];
    for (const action of ['read-old', 'migrate', 'read-old', 'write-new', 'read-new', 'read-old', 'rollback', 'read-old'] as const) {
      snapshots.push(await act(session, action));
    }
    assert.ok(snapshots.every(snapshot => snapshot.events.at(-1)?.outcome === 'passed'));
    assert.ok(snapshots.every(snapshot => snapshot.databaseId === initial.databaseId));
    const written = snapshots[3];
    const final = snapshots.at(-1)!;
    assert.equal(final.selectedSessionId, written.selectedSessionId);
    assert.deepEqual(selected(final).session_payload, selected(written).session_payload);
    assert.equal(final.events.at(-1)?.read?.userId, initial.label);
    assert.equal(final.events.at(-1)?.read?.writeMarker, (selected(written).session_payload as Record<string, unknown>).writeMarker);
    assert.equal(final.revision, 8);
    assert.deepEqual(final.columns, ['id', 'session_payload']);
  } finally { await session.close(); }
});

test('invalid action, phase, revision and second write cannot mutate the persistent database', async () => {
  const session = await createLabSession({ variant: 'breaking', label: 'Bounds' });
  try {
    const initial = await session.snapshot();
    const invalid: LabCommand[] = [
      { commandId: randomUUID(), expectedRevision: 0, action: 'write-new' },
      { commandId: randomUUID(), expectedRevision: 0, action: 'read-new' },
      { commandId: randomUUID(), expectedRevision: 0, action: 'rollback' },
      { commandId: randomUUID(), expectedRevision: 1, action: 'migrate' },
      { commandId: randomUUID(), expectedRevision: 0, action: 'reset' as LabAction },
      { commandId: undefined as unknown as string, expectedRevision: 0, action: 'migrate' },
    ];
    for (const command of invalid) await assert.rejects(session.execute(command), LabError);
    assert.deepEqual(await session.snapshot(), initial);
    await act(session, 'migrate');
    const written = await act(session, 'write-new');
    await assert.rejects(act(session, 'write-new'), error => error instanceof LabError && error.code === 'invalid-phase');
    await assert.rejects(act(session, 'migrate'), error => error instanceof LabError && error.code === 'invalid-phase');
    assert.deepEqual(await session.snapshot(), written);
  } finally { await session.close(); }
  await session.close();
  await assert.rejects(session.snapshot(), error => error instanceof LabError && error.code === 'closed');
});

test('duplicate commands return immutable prior snapshots and concurrent revisions cannot execute twice', async () => {
  const session = await createLabSession({ variant: 'compatible', label: 'Retries' });
  try {
    const command: LabCommand = { commandId: randomUUID(), expectedRevision: 0, action: 'migrate' };
    const [first, duplicate] = await Promise.all([session.execute(command), session.execute(command)]);
    assert.deepEqual(first, duplicate);
    assert.equal(first.revision, 1);
    first.events[0].title = 'tampered response';
    first.rows.length = 0;
    assert.deepEqual(await session.execute(command), duplicate);
    const next = await act(session, 'write-new');
    assert.deepEqual(await session.execute(command), duplicate, 'a retry returns its original revision, not the latest snapshot');
    assert.equal((await session.snapshot()).revision, next.revision);
    await assert.rejects(session.execute({ ...command, action: 'rollback' }), LabError);
    const competing = await Promise.allSettled([
      session.execute({ commandId: randomUUID(), expectedRevision: 2, action: 'read-new' }),
      session.execute({ commandId: randomUUID(), expectedRevision: 2, action: 'rollback' }),
    ]);
    assert.equal(competing[0].status, 'fulfilled');
    assert.equal(competing[1].status, 'rejected');
    const final = await session.snapshot();
    assert.equal(final.revision, 3);
    assert.equal(final.phase, 'upgraded');
  } finally { await session.close(); }
});

test('event cap rejects further actions but still permits strict idempotent retries', async () => {
  const session = await createLabSession({ variant: 'compatible', label: 'Event limit' });
  try {
    const firstCommand: LabCommand = { commandId: randomUUID(), expectedRevision: 0, action: 'read-old' };
    const first = await session.execute(firstCommand);
    let last = first;
    while (last.events.length < 100) last = await session.execute({ commandId: randomUUID(), expectedRevision: last.revision, action: 'read-old' });
    assert.equal(last.revision, 99);
    assert.deepEqual(last.allowedActions, []);
    await assert.rejects(act(session, 'migrate'), error => error instanceof LabError && error.code === 'event-limit');
    assert.deepEqual(await session.execute(firstCommand), first);
    assert.equal((await session.snapshot()).events.length, 100);
  } finally { await session.close(); }
});

test('setup failures are inconclusive with no permitted actions and release allocated databases', async context => {
  context.mock.method(PGlite.prototype, 'transaction', async () => { throw new Error('simulated fixture setup failure'); });
  const close = context.mock.method(PGlite.prototype, 'close');
  const session = await createLabSession({ variant: 'breaking', label: 'Setup error' });
  try {
    const snapshot = await session.snapshot();
    assert.equal(snapshot.events[0].outcome, 'inconclusive');
    assert.match(snapshot.events[0].explanation, /fixture setup failure/);
    assert.deepEqual(snapshot.allowedActions, []);
    assert.equal(snapshot.revision, 0);
    await assert.rejects(act(session, 'migrate'), LabError);
  } finally { await session.close(); }
  const databases = new Set(close.mock.calls.map(call => call.this as PGlite));
  assert.ok(databases.size >= 1);
  assert.ok([...databases].every(db => db.closed));
});

test('label and variant validation reject malformed inputs before database allocation', async () => {
  for (const input of [
    { variant: 'other', label: 'demo' }, { variant: 'breaking', label: '' },
    { variant: 'breaking', label: '  ' }, { variant: 'breaking', label: 'x'.repeat(49) },
    { variant: 'breaking', label: 'a\nb' }, { variant: 'breaking', label: 'a\u0085b' },
    { variant: 'breaking', label: null }, null,
  ]) await assert.rejects(createLabSession(input as LabCreateInput), error => error instanceof LabError && error.code === 'invalid-input');
});
