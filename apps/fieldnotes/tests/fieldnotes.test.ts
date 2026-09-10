import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { OperationResult, Snapshot } from '../protocol.js';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const manifestRelease = JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8')).release as string;
const command = (name: string, args: string[]) => {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
};
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  await closed; clearTimeout(force);
}
async function eventually<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 100; i++) { try { return await operation(); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 100)); } }
  throw last;
}
const nativeAvailable = spawnSync('initdb', ['--version'], { encoding: 'utf8' }).status === 0;

for (const variant of ['breaking', 'compatible'] as const) test(`two native apps: ${variant} checklist saves, shared rollout and same-row rollback`, { skip: !nativeAvailable, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'fieldnotes-native-'));
  const databases: { process: ChildProcess; url: string; path: string }[] = [];
  const processes: ChildProcess[] = [];
  const token = randomUUID();
  const ports = await Promise.all(Array.from({ length: 4 }, freePort));
  const apps = ['left', 'right'].map((name, i) => ({ name, port: ports[i * 2], adminPort: ports[i * 2 + 1], stateFile: join(root, `${name}.json`), child: undefined as ChildProcess | undefined }));
  async function boot(index: number, release?: string) {
    const app = apps[index];
    const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd, env: { ...process.env,
      GECCO_DATABASE_URL: databases[index].url, GECCO_ADMIN_TOKEN: token, GECCO_RELEASE: release, GECCO_STATE_FILE: app.stateFile,
      GECCO_HOST: '127.0.0.1', PORT: String(app.port), GECCO_ADMIN_PORT: String(app.adminPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(child); app.child = child;
    let diagnostic = ''; child.stderr?.on('data', chunk => { diagnostic += String(chunk); });
    return eventually(async () => { assert.equal(child.exitCode, null, diagnostic); return request<Snapshot>(index, '/admin/state'); });
  }
  async function request<T = OperationResult>(index: number, path: string, input?: unknown, admin = true): Promise<T> {
    const app = apps[index];
    const response = await fetch(`http://127.0.0.1:${admin ? app.adminPort : app.port}${path}`, {
      ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
      headers: { ...(admin ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data as T;
  }
  try {
    for (const name of ['left', 'right']) {
      const path = join(root, `pg-${name}`); const socket = join(root, `socket-${name}`); await mkdir(socket);
      command('initdb', ['-D', path, '--auth=trust', '--no-locale', '--encoding=UTF8']);
      const port = await freePort(); const child = spawn('postgres', ['-D', path, '-h', '127.0.0.1', '-p', String(port), '-k', socket], { stdio: 'ignore' });
      const url = `postgresql://${process.env.USER}@127.0.0.1:${port}/postgres`;
      databases.push({ process: child, url, path });
      await eventually(async () => { const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 }); try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end(); } });
    }
    const leftBoot = await boot(0, manifestRelease === 'v1' ? undefined : 'v1');
    const rightBoot = await boot(1, manifestRelease === `v2-${variant}` ? undefined : `v2-${variant}`);
    assert.equal(leftBoot.release, 'v1');
    assert.equal(leftBoot.releaseSelection, manifestRelease === 'v1' ? 'checkout' : 'override');
    assert.equal(rightBoot.releaseSelection, manifestRelease === `v2-${variant}` ? 'checkout' : 'override');
    if (manifestRelease === 'v1') assert.equal(leftBoot.releaseEntryPoint, 'apps/fieldnotes/release.ts');
    if (manifestRelease === `v2-${variant}`) assert.equal(rightBoot.releaseEntryPoint, 'apps/fieldnotes/release.ts');
    assert.notEqual(leftBoot.instanceId, rightBoot.instanceId);
    assert.notEqual(leftBoot.database.id, rightBoot.database.id);
    assert.match(leftBoot.database.postgresVersion!, /^PostgreSQL /);
    const initialChecklist = '- [x] Draft release notes\n- [ ] Test the upgrade\n- [ ] Announce launch';
    const testedChecklist = '- [x] Draft release notes\n- [x] Test the upgrade\n- [ ] Announce launch';
    const completedChecklist = '- [x] Draft release notes\n- [x] Test the upgrade\n- [x] Announce launch';
    const fixture = { label: "Zoë O'Connor", sessionId: `old-${randomUUID()}`, writeMarker: `old-write-${randomUUID()}`, note: initialChecklist };
    for (const index of [0, 1]) assert.equal((await request(index, '/admin/initialize', fixture)).outcome, 'passed');
    assert.equal((await request(1, '/admin/migrate', { variant, direction: 'up' })).outcome, 'passed');
    for (const index of [0, 1]) {
      const read = await request(index, '/api/workspace', undefined, false); assert.equal(read.outcome, 'passed');
      assert.equal(read.snapshot.observation?.userId, fixture.label);
      assert.equal(read.snapshot.observation?.note, fixture.note);
    }
    // Same request body the V2 board sends for its "Test the upgrade" checkbox.
    const save = { commandId: randomUUID(), note: testedChecklist };
    const saved = await request(1, '/api/note', save, false); assert.equal(saved.outcome, 'passed');
    assert.equal(saved.snapshot.observation?.note, testedChecklist);
    assert(saved.trace.some(step => step.sql.startsWith('INSERT INTO notes') && step.rows?.[0]?.body === testedChecklist), 'completion is backed by the actual PostgreSQL save result');
    const automated = await request(1, '/admin/config', { autonomous: true });
    assert.deepEqual(automated.snapshot.observation, saved.snapshot.observation, 'toggling autonomous mode retains actual observation');
    await request(1, '/admin/config', { autonomous: false });
    assert.deepEqual(await request(1, '/api/note', save, false), saved, 'same id returns immutable response without repeating write');
    assert.equal((await request(1, '/api/workspace', undefined, false)).snapshot.observation?.note, testedChecklist, 'a separate proposed-app request reads the saved checkmark');
    assert.equal((await request(0, '/api/workspace', undefined, false)).snapshot.observation?.note, initialChecklist, 'proposed-app checklist save leaves the previous baseline untouched');
    const adminOnPublic = await fetch(`http://127.0.0.1:${apps[0].port}/admin/state`); assert.equal(adminOnPublic.status, 404);
    const unauthed = await fetch(`http://127.0.0.1:${apps[0].adminPort}/admin/state`); assert.equal(unauthed.status, 401);
    const html = await (await fetch(`http://127.0.0.1:${apps[0].port}/`)).text(); assert.match(html, /fieldnotes/); assert(!html.includes(token));
    const script = await (await fetch(`http://127.0.0.1:${apps[0].port}/app.js`)).text(); assert(!script.includes('/api/twins'));
    const unknown = await fetch(`http://127.0.0.1:${apps[0].adminPort}/admin/query`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ statement: 'DROP TABLE sessions', parameters: [] }) }); assert.equal(unknown.status, 400);
    await request(0, '/admin/config', { autonomous: true });
    const locked = await fetch(`http://127.0.0.1:${apps[0].port}/api/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), note: 'Should not write' }) }); assert.equal(locked.status, 409);
    await request(0, '/admin/config', { autonomous: false });
    await request(0, '/admin/migrate', { variant, direction: 'up' });
    await request(1, '/admin/config', { database: { kind: 'gateway', url: `http://127.0.0.1:${apps[0].adminPort}`, token, databaseId: leftBoot.database.id } });
    const mixedLeft = await request(0, '/admin/read', {}); const mixedRight = await request(1, '/admin/read', {});
    assert.equal(mixedLeft.outcome, variant === 'breaking' ? 'failed' : 'passed'); assert.equal(mixedRight.outcome, 'passed');
    if (variant === 'breaking') assert.equal(mixedLeft.error?.code, '42703');
    assert.equal(mixedRight.snapshot.observation?.note, initialChecklist, 'rollout now reads the left database; it does not fabricate copying the right baseline edit');
    const inactiveBaseline = new pg.Client({ connectionString: databases[1].url });
    try {
      await inactiveBaseline.connect();
      const retained = await inactiveBaseline.query('SELECT body FROM notes WHERE user_id = $1', [fixture.label]);
      assert.equal(retained.rows[0]?.body, testedChecklist, 'the standalone checkmark remains in the retained right baseline database');
    } finally { await inactiveBaseline.end(); }
    const rolloutSave = await request(1, '/api/note', { commandId: randomUUID(), note: testedChecklist }, false);
    assert.equal(rolloutSave.outcome, 'passed', 'the proposed app remains directly usable during mixed rollout');
    assert.equal(rolloutSave.snapshot.observation?.note, testedChecklist);
    assert(rolloutSave.trace.every(step => step.databaseId === leftBoot.database.id));
    const previousSave = await request(0, '/api/note', { commandId: randomUUID(), note: completedChecklist }, false);
    assert.equal(previousSave.outcome, variant === 'breaking' ? 'failed' : 'passed');
    if (variant === 'breaking') {
      assert.equal(previousSave.error?.code, '42703');
      assert(!previousSave.trace.some(step => step.sql.startsWith('INSERT INTO notes')), 'failed session read prevents the old app from changing the checklist');
    }
    const sharedChecklist = variant === 'breaking' ? testedChecklist : completedChecklist;
    assert.equal((await request(1, '/api/workspace', undefined, false)).snapshot.observation?.note, sharedChecklist, 'actual shared note reflects only successful saves');
    if (variant === 'compatible') assert.equal((await request(0, '/api/workspace', undefined, false)).snapshot.observation?.note, sharedChecklist, 'the compatible release lets both apps read and save');
    const newer = { id: `new-${randomUUID()}`, userId: fixture.label, role: 'editor', writeMarker: `new-write-${randomUUID()}` };
    assert.equal((await request(1, '/admin/write-session', { session: newer })).outcome, 'passed');
    await request(0, '/admin/config', { selectedSessionId: newer.id });
    const newRead = await request(1, '/admin/read', {}); assert.equal(newRead.snapshot.observation?.writeMarker, newer.writeMarker);
    const sharedSave = await request(1, '/api/note', { commandId: randomUUID(), note: completedChecklist }, false); assert.equal(sharedSave.outcome, 'passed');
    assert.equal(sharedSave.snapshot.observation?.note, completedChecklist, 'checkmarks remain usable after the new-version session write');
    const beforeRollback = await request<any>(0, '/admin/rows'); assert(beforeRollback.rows.some((row: any) => row.id === newer.id));
    assert.equal((await request(0, '/admin/migrate', { variant, direction: 'down' })).outcome, 'passed');
    await stop(apps[1].child); const rollbackBoot = await boot(1, 'v1');
    assert.notEqual(rollbackBoot.instanceId, rightBoot.instanceId); assert.equal(rollbackBoot.database.id, leftBoot.database.id);
    for (const index of [0, 1]) {
      const rollbackRead = await request(index, '/api/workspace', undefined, false);
      assert.equal(rollbackRead.outcome, variant === 'breaking' ? 'failed' : 'passed');
      if (variant === 'breaking') { assert.equal(rollbackRead.error?.name, 'SessionContractError'); assert.equal(rollbackRead.error?.code, undefined); }
      else { assert.equal(rollbackRead.snapshot.observation?.writeMarker, newer.writeMarker); assert.equal(rollbackRead.snapshot.observation?.note, sharedSave.snapshot.observation?.note); }
      assert(rollbackRead.trace.every(step => step.databaseId === leftBoot.database.id));
    }
    const afterRollback = await request<any>(0, '/admin/rows'); const newRow = afterRollback.rows.find((row: any) => row.id === newer.id);
    assert.equal(newRow.session_payload.writeMarker, newer.writeMarker);
    assert.equal(afterRollback.rows.length, beforeRollback.rows.length, 'rollback preserves exact newly written row');
    assert.equal(afterRollback.notes.find((row: any) => row.user_id === fixture.label)?.body, completedChecklist, 'the saved checklist survives rollback even when the old decoder cannot open it');
    const publicState = await request<Snapshot>(1, '/api/state', undefined, false); assert(!JSON.stringify(publicState).includes(token));
  } finally {
    for (const process of processes) await stop(process);
    for (const database of databases) await stop(database.process);
    await rm(root, { recursive: true, force: true });
  }
});
