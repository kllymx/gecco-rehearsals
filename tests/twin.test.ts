import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createTwinSession, TwinError, type TwinSession } from '../engine/twin.js';
import type { TwinAction, TwinCommand, TwinSnapshot } from '../shared/twin.js';

async function act(session: TwinSession, action: TwinAction, note?: string): Promise<TwinSnapshot> {
  return session.execute({ commandId: randomUUID(), expectedRevision: (await session.snapshot()).revision, action, ...(note !== undefined ? { note } : {}) });
}
function appPid(instanceId: string): number {
  const match = /^app-(\d+)-/.exec(instanceId); assert.ok(match); return Number(match[1]);
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test('separate app processes and databases pass alone, then retain shared writes through a real rollback process replacement', async () => {
  const label = "Astra's 東京 demo";
  const session = await createTwinSession({ variant: 'breaking', label });
  const pids = new Set<number>();
  try {
    const initial = await session.snapshot();
    assert.equal(initial.events[0].outcome, 'passed');
    const { left, right } = initial.apps;
    pids.add(appPid(left.instanceId)); pids.add(appPid(right.instanceId));
    assert.equal(pids.size, 2);
    assert.ok([...pids].every(alive));
    assert.ok(!pids.has(process.pid));
    assert.notEqual(left.databaseId, right.databaseId);
    assert.equal(left.sessionId, right.sessionId);
    assert.deepEqual(initial.automation, { status: 'idle', stepIndex: 0, totalSteps: 8 });
    const firstRead = await act(session, 'read-both');
    assert.equal(firstRead.apps.left.observation?.outcome, 'passed');
    assert.equal(firstRead.apps.right.observation?.outcome, 'passed');
    assert.equal(firstRead.apps.left.observation?.writeMarker, firstRead.apps.right.observation?.writeMarker);
    assert.equal(firstRead.apps.left.observation?.userId, label);
    assert.equal(firstRead.apps.right.observation?.userId, label);
    const isolatedNote = await act(session, 'save-left', "Left note isn't shared yet");
    assert.equal(isolatedNote.apps.left.observation?.note, "Left note isn't shared yet");
    assert.notEqual(isolatedNote.databases[0].note, isolatedNote.databases[1].note);
    assert.equal(isolatedNote.apps.right.stale, false, 'a write to another database cannot stale the right app');
    const inactiveDatabase = structuredClone(isolatedNote.databases.find(db => db.id === right.databaseId)!);
    const deployed = await act(session, 'deploy');
    assert.equal(deployed.phase, 'rollout');
    assert.equal(deployed.apps.left.databaseId, deployed.apps.right.databaseId);
    assert.equal(deployed.apps.left.databaseId, left.databaseId);
    assert.equal(deployed.apps.left.instanceId, left.instanceId);
    assert.equal(deployed.apps.right.instanceId, right.instanceId);
    assert.ok(deployed.apps.left.stale && deployed.apps.right.stale);
    const mixed = await act(session, 'read-both');
    assert.equal(mixed.apps.left.observation?.outcome, 'failed');
    assert.match(mixed.apps.left.observation?.error ?? '', /42703/);
    assert.equal(mixed.apps.right.observation?.outcome, 'passed');
    assert.equal(mixed.apps.right.observation?.note, "Left note isn't shared yet");
    const beforeRejectedSave = structuredClone(mixed.databases);
    const rejectedSave = await act(session, 'save-left', 'MUST NOT BE SAVED');
    assert.equal(rejectedSave.events.at(-1)?.outcome, 'failed');
    assert.ok(!rejectedSave.events.at(-1)?.sql.some(sql => sql.query.startsWith('UPDATE notes')));
    assert.deepEqual(rejectedSave.databases, beforeRejectedSave);
    const written = await act(session, 'write-new');
    assert.equal(written.apps.left.sessionId, written.apps.right.sessionId);
    assert.notEqual(written.apps.left.sessionId, left.sessionId);
    assert.ok(written.apps.left.stale && written.apps.right.stale);
    const readNew = await act(session, 'read-right');
    const newMarker = readNew.apps.right.observation?.writeMarker;
    assert.ok(newMarker?.startsWith('twin-v2-write-'));
    assert.equal(readNew.apps.right.observation?.role, 'editor');
    const saved = await act(session, 'save-right', 'Shared note survives rollback');
    assert.equal(saved.apps.right.observation?.note, 'Shared note survives rollback');
    assert.equal(saved.apps.right.stale, false);
    assert.equal(saved.apps.left.stale, true);
    const rolled = await act(session, 'rollback');
    assert.equal(rolled.phase, 'rollback');
    assert.equal(rolled.apps.left.instanceId, left.instanceId);
    assert.notEqual(rolled.apps.right.instanceId, right.instanceId);
    pids.add(appPid(rolled.apps.right.instanceId));
    assert.equal(alive(appPid(right.instanceId)), false, 'old right process must exit before replacement returns');
    assert.ok(alive(appPid(rolled.apps.right.instanceId)));
    assert.equal(rolled.apps.right.release, 'v1');
    assert.equal(rolled.apps.left.databaseId, left.databaseId);
    assert.equal(rolled.apps.right.databaseId, left.databaseId);
    const final = await act(session, 'read-both');
    assert.equal(final.apps.left.observation?.outcome, 'failed');
    assert.equal(final.apps.right.observation?.outcome, 'failed');
    assert.match(final.apps.left.observation?.error ?? '', /v1 requires flat/);
    assert.match(final.apps.right.observation?.error ?? '', /v1 requires flat/);
    const persisted = final.databases.find(db => db.id === left.databaseId)!.rows.find(row => row.id === written.apps.left.sessionId)!;
    assert.equal((persisted.session_payload as Record<string, unknown>).writeMarker, newMarker);
    assert.equal(final.databases.find(db => db.id === left.databaseId)?.note, 'Shared note survives rollback');
    assert.deepEqual(final.databases.find(db => db.id === right.databaseId), inactiveDatabase);
    assert.equal(final.fixtureDigest, initial.fixtureDigest);
    assert.equal(final.sourceDigest, initial.sourceDigest);
    assert.ok(final.events.every(event => event.sql.every(sql => sql.databaseId === left.databaseId || sql.databaseId === right.databaseId)));
    assert.ok(final.events.every(event => event.sql.every(sql => !sql.query.includes(label))));
    assert.ok(final.events.some(event => event.sql.some(sql => sql.parameters?.includes(label))));
  } finally { await session.close(); }
  assert.ok([...pids].every(pid => !alive(pid)), 'all owned app processes must exit on close');
});

test('compatible apps save and reread each other’s notes before and after rollback with the same session marker', async () => {
  const session = await createTwinSession({ variant: 'compatible', label: 'Compatible user' });
  try {
    await act(session, 'read-both');
    await act(session, 'deploy');
    await act(session, 'write-new');
    const both = await act(session, 'read-both');
    const marker = both.apps.right.observation?.writeMarker;
    const leftSaved = await act(session, 'save-left', 'Written by old app after deploy');
    assert.equal(leftSaved.apps.left.stale, false);
    assert.equal(leftSaved.apps.right.stale, true);
    const rightRead = await act(session, 'read-right');
    assert.equal(rightRead.apps.right.observation?.note, 'Written by old app after deploy');
    await act(session, 'rollback');
    await act(session, 'save-right', 'Written by rolled-back app\nwith a second line');
    const final = await act(session, 'read-both');
    assert.ok(final.events.every(event => event.outcome === 'passed'));
    assert.equal(final.apps.left.observation?.note, 'Written by rolled-back app\nwith a second line');
    assert.equal(final.apps.right.observation?.note, final.apps.left.observation?.note);
    assert.equal(final.apps.left.observation?.writeMarker, marker);
    assert.equal(final.apps.right.observation?.writeMarker, marker);
    assert.equal(final.apps.left.release, 'v1'); assert.equal(final.apps.right.release, 'v1');
  } finally { await session.close(); }
});

test('commands are revision checked, retries immutable, malformed actions rejected and all databases close', async context => {
  const close = context.mock.method(PGlite.prototype, 'close');
  const session = await createTwinSession({ variant: 'compatible', label: 'Retry user' });
  try {
    const initial = await session.snapshot();
    const invalid: TwinCommand[] = [
      { commandId: randomUUID(), expectedRevision: 0, action: 'write-new' },
      { commandId: randomUUID(), expectedRevision: 0, action: 'rollback' },
      { commandId: randomUUID(), expectedRevision: 0, action: 'save-left', note: 'a'.repeat(281) },
      { commandId: randomUUID(), expectedRevision: 0, action: 'save-right' },
      { commandId: undefined as unknown as string, expectedRevision: 0, action: 'deploy' },
      { commandId: randomUUID(), expectedRevision: 1, action: 'deploy' },
      { commandId: randomUUID(), expectedRevision: 0, action: 'read-left', note: 'unexpected' },
    ];
    for (const command of invalid) await assert.rejects(session.execute(command), TwinError);
    assert.deepEqual(await session.snapshot(), initial);
    const command: TwinCommand = { commandId: randomUUID(), expectedRevision: 0, action: 'deploy' };
    const [first, retry] = await Promise.all([session.execute(command), session.execute(command)]);
    assert.deepEqual(first, retry);
    first.events.length = 0; first.databases[0].rows.length = 0;
    assert.deepEqual(await session.execute(command), retry);
    await act(session, 'write-new');
    assert.deepEqual(await session.execute(command), retry);
    await assert.rejects(session.execute({ ...command, action: 'read-left' }), TwinError);
    await assert.rejects(act(session, 'write-new'), TwinError);
    const racing = await Promise.allSettled([
      session.execute({ commandId: randomUUID(), expectedRevision: 2, action: 'read-both' }),
      session.execute({ commandId: randomUUID(), expectedRevision: 2, action: 'rollback' }),
    ]);
    assert.equal(racing[0].status, 'fulfilled'); assert.equal(racing[1].status, 'rejected');
    assert.equal((await session.snapshot()).phase, 'rollout');
  } finally { await session.close(); }
  await session.close();
  const databases = new Set(close.mock.calls.map(call => call.this as PGlite));
  assert.ok(databases.size >= 2);
  assert.ok([...databases].every(db => db.closed));
  await assert.rejects(session.snapshot(), TwinError);
});

test('an app process failure produces inconclusive evidence and disables subsequent mutations', async () => {
  const session = await createTwinSession({ variant: 'breaking', label: 'Process failure' });
  try {
    const initial = await session.snapshot();
    process.kill(appPid(initial.apps.left.instanceId), 'SIGKILL');
    const result = await act(session, 'read-both');
    assert.equal(result.events.at(-1)?.outcome, 'inconclusive');
    assert.equal(result.apps.left.observation?.outcome, 'inconclusive');
    assert.equal(result.apps.right.observation?.outcome, 'passed');
    assert.deepEqual(result.allowedActions, []);
    await assert.rejects(act(session, 'deploy'), TwinError);
  } finally { await session.close(); }
});
