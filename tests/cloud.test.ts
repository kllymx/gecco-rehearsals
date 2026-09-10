import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createCloudManager, type CloudManager, type CloudOptions } from '../server/cloud.js';
import type { DaytonaProvider, DaytonaSide } from '../server/daytona-provider.js';
import type { CloudSnapshot } from '../shared/cloud.js';
import { createApp } from '../server/app.js';

const ref = 'a'.repeat(40);
const sourceRefs = { base: ref, breaking: 'b'.repeat(40), compatible: 'c'.repeat(40) };
const sides = ['left', 'right'] as const;
const hasStatus = (status: number) => (error: unknown) => !!error && typeof error === 'object' && 'statusCode' in error && error.statusCode === status;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(manager: CloudManager, id: string, predicate: (value: CloudSnapshot) => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await manager.snapshot(id);
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Cloud state did not reach the expected condition: ${JSON.stringify(await manager.snapshot(id))}`);
}
function cloudMocks() {
  const creates: string[] = [], closes: string[] = [];
  const commands: Array<{ side: DaytonaSide; command: string; operationId: string }> = [];
  const requests: Array<{ side: DaytonaSide; path: string; body?: Record<string, unknown> }> = [];
  const uploads: Array<{ side: DaytonaSide; path: string; content: string }> = [];
  const adminTokens = new Set<string>();
  const state = Object.fromEntries(sides.map(side => [side, { release: side === 'left' ? 'v1' : 'v2-breaking',
    instanceId: `app-${side}-first`, pid: side === 'left' ? 101 : 102, startedAt: new Date().toISOString(),
    database: { id: `database-${side}`, kind: 'local', postgresVersion: 'PostgreSQL test fixture' },
    observation: null as null | { outcome: string; note: string }, revision: 0 }])) as Record<DaytonaSide, {
      release: string; instanceId: string; pid: number; startedAt: string;
      database: { id: string; kind: string; postgresVersion: string };
      observation: null | { outcome: string; note: string }; revision: number;
    }>;
  let ensureGate: (() => Promise<void>) | undefined;
  let commandFailure = false, cleanupComplete = true;
  let responseOverride: ((side: DaytonaSide, path: string, body: Record<string, unknown> | undefined) => Response | Promise<Response | undefined> | undefined) | undefined;
  const pair = (id: string) => ({ experimentId: id,
    left: { side: 'left' as const, name: 'left-sandbox', id: 'sandbox-left', state: 'started', resources: { cpu: 1, memory: 2, disk: 3 } },
    right: { side: 'right' as const, name: 'right-sandbox', id: 'sandbox-right', state: 'started', resources: { cpu: 1, memory: 2, disk: 3 } } });
  const provider: DaytonaProvider = {
    workDirectory: '/home/daytona/gecco', pendingOperations: () => 0,
    async ensurePair(id) { creates.push(id); await ensureGate?.(); return pair(id); },
    async inspectPair(id) { return pair(id); },
    async uploadFiles(_id, side, files) {
      for (const file of files) {
        const content = Buffer.from(file.bytes).toString(); uploads.push({ side, path: file.path, content });
        if (file.path === 'runtime/app.env') {
          const env = Object.fromEntries(content.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
          adminTokens.add(env.GECCO_ADMIN_TOKEN);
          if (env.GECCO_RELEASE) state[side].release = env.GECCO_RELEASE;
        }
      }
      return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes.length, 0) };
    },
    async execute(_id, side, input) {
      commands.push({ side, command: input.command, operationId: input.operationId });
      for (const [variant, commit] of Object.entries(sourceRefs)) if (input.command.includes(`checkout --detach '${commit}'`))
        state[side].release = variant === 'base' ? 'v1' : `v2-${variant}`;
      if (input.command.includes('kill -TERM')) state[side].instanceId = `app-${side}-replacement`;
      return { operationId: input.operationId, exitCode: commandFailure ? 19 : 0, output: commandFailure ? 'actual fixture setup failure' : 'actual fixture setup output',
        outputBytes: 27, outputTruncated: false, completedAt: new Date().toISOString() };
    },
    async preview(_id, side, port) { return { url: `https://${side}-${port}.preview.example/`, headers: {
      'x-daytona-preview-token': `private-preview-${side}`, 'x-daytona-skip-preview-warning': 'true' } }; },
    async signedPreview(_id, side, port, expiry = 3600) { return { url: `https://${side}-${port}.preview.example/?signed=browser-${side}`,
      expiresAt: new Date(Date.now() + expiry * 1000).toISOString() }; },
    async cleanupPair(id) {
      closes.push(id); return { experimentId: id, complete: cleanupComplete, observedAt: new Date().toISOString(),
        sides: sides.map(side => ({ side, name: `${side}-sandbox`, id: `sandbox-${side}`, state: cleanupComplete ? 'deleted' as const : 'uncertain' as const,
          stoppedVerified: cleanupComplete, deletedVerified: cleanupComplete })) };
    },
  };
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const side = url.hostname.startsWith('left-') ? 'left' : 'right';
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, `${side}-4000.preview.example`);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-daytona-preview-token'), `private-preview-${side}`);
    assert(adminTokens.has(headers.get('authorization')!.slice('Bearer '.length)));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ side, path: url.pathname, body });
    const override = await responseOverride?.(side, url.pathname, body);
    if (override) return override;
    if (url.pathname === '/admin/state') return Response.json(state[side]);
    if (url.pathname === '/admin/config' && body?.database) {
      const target = body.database as { kind: string; databaseId: string };
      state[side].database.kind = target.kind; state[side].database.id = target.databaseId;
    }
    if (url.pathname === '/admin/read') state[side].observation = { outcome: 'passed', note: 'An observed fixture note' };
    state[side].revision++;
    return Response.json({ snapshot: state[side], outcome: 'passed', trace: [{ sql: 'fixture statement', rows: [{ actual: true }] }] });
  };
  return { provider, http, state, creates, closes, commands, requests, uploads, adminTokens,
    ensure: (gate: typeof ensureGate) => { ensureGate = gate; },
    commandFailure: (value: boolean) => { commandFailure = value; },
    cleanupComplete: (value: boolean) => { cleanupComplete = value; },
    response: (value: typeof responseOverride) => { responseOverride = value; } };
}
async function setup(t: TestContext, overrides: Partial<CloudOptions> = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'gecco-cloud-test-'));
  const mock = cloudMocks();
  const options: CloudOptions = { provider: mock.provider, fetch: mock.http, stateDirectory, sourceRef: ref,
    dwellMs: 60_000, bootstrapCommand: 'test-native-bootstrap', ...overrides };
  const manager = createCloudManager(options);
  t.after(async () => { await manager.closeAll(); await rm(stateDirectory, { recursive: true, force: true }); });
  return { ...mock, manager, options, stateDirectory };
}

test('unconfigured cloud service refuses execution and does not substitute a local result', async t => {
  const f = await setup(t, { provider: undefined });
  assert.equal((await f.manager.status()).configured, false);
  await assert.rejects(f.manager.create({ variant: 'breaking', label: 'Demo' }), hasStatus(503));
  assert.equal(f.creates.length, 0);
  const unpinned = await setup(t, { sourceRef: 'main' });
  await assert.rejects(unpinned.manager.create({ variant: 'breaking', label: 'Demo' }), hasStatus(503));
  assert.equal(unpinned.creates.length, 0);
});

test('create returns provisioning before cloud allocation completes; closing waits for accepted allocation then cleans up', async t => {
  const f = await setup(t);
  const started = deferred<void>(), gate = deferred<void>();
  f.ensure(async () => { started.resolve(); await gate.promise; });
  const initial = await f.manager.create({ variant: 'breaking', label: 'Demo' });
  assert.equal(initial.status, 'provisioning');
  assert.equal(initial.provider, 'daytona');
  assert.equal(initial.apps.left.previewUrl, undefined);
  await started.promise;
  await assert.rejects(f.manager.create({ variant: 'compatible', label: 'Other' }), hasStatus(409));
  assert.equal((await f.manager.close(initial.id)).status, 'closing');
  assert.equal(f.closes.length, 0);
  gate.resolve();
  const closed = await until(f.manager, initial.id, state => state.status === 'closed');
  assert.equal(f.commands.length, 0);
  assert.equal(f.closes.length, 1);
  assert.equal(closed.apps.left.state, 'deleted');
  assert.equal((await f.manager.status()).activeId, undefined);
});

test('setup failure is recorded with its actual exit status and releases capacity only after verified cleanup', async t => {
  const f = await setup(t);
  f.commandFailure(true);
  const initial = await f.manager.create({ variant: 'compatible', label: 'Demo' });
  const closed = await until(f.manager, initial.id, state => state.status === 'closed');
  assert(closed.events.some(event => JSON.stringify(event.evidence ?? {}).includes('actual fixture setup failure')));
  assert(closed.events.some(event => (event.evidence as { exitCode?: number })?.exitCode === 19));
  assert.equal(closed.apps.left.previewUrl, undefined);
  assert.equal(closed.events.filter(event => event.outcome === 'passed').length, 0);
  assert.equal((await f.manager.status()).activeId, undefined);
  f.commandFailure(false);
  const replacement = await f.manager.create({ variant: 'breaking', label: 'Next' });
  assert.notEqual(replacement.id, initial.id);
});

test('unconfirmed cleanup holds capacity and a later close reconciles instead of creating again', async t => {
  const f = await setup(t);
  f.commandFailure(true); f.cleanupComplete(false);
  const initial = await f.manager.create({ variant: 'breaking', label: 'Demo' });
  const failed = await until(f.manager, initial.id, state => state.status === 'failed' && state.progress.stage === 'Cleanup needs attention');
  assert.equal((failed.cleanup as { complete: boolean }).complete, false);
  await assert.rejects(f.manager.create({ variant: 'breaking', label: 'Other' }), hasStatus(409));
  f.cleanupComplete(true);
  await f.manager.close(initial.id);
  await until(f.manager, initial.id, state => state.status === 'closed');
  assert.equal(f.creates.length, 1);
  assert.equal((await f.manager.status()).activeId, undefined);
});

test('live app URLs are provider-issued; private admin and preview tokens stay out of snapshots and event evidence', async t => {
  const f = await setup(t);
  const initial = await f.manager.create({ variant: 'breaking', label: 'Demo' });
  const live = await until(f.manager, initial.id, state => state.status === 'running' && !state.busy);
  assert.equal(live.apps.left.previewUrl, 'https://left-3000.preview.example/?signed=browser-left');
  assert.equal(live.apps.right.previewUrl, 'https://right-3000.preview.example/?signed=browser-right');
  assert.equal(live.apps.left.instanceId, 'app-left-first');
  assert.equal(live.apps.left.databaseId, 'database-left');
  assert.equal(live.apps.right.databaseId, 'database-right');
  assert(f.commands.some(command => command.command.includes(ref) && command.command.includes('npm ci')));
  const serialized = JSON.stringify(live);
  for (const token of f.adminTokens) assert(!serialized.includes(token));
  assert(!serialized.includes('private-preview-'));
  const stored = JSON.parse(await readFile(join(f.stateDirectory, `${initial.id}.json`), 'utf8'));
  assert(!JSON.stringify(stored.state).includes('browser-left'));
  assert(!JSON.stringify(stored.state).includes('private-preview-'));
  // Server-only credentials are retained privately for restart cleanup, never evidence.
  assert(f.adminTokens.has(stored.adminToken));
});

test('autonomy executes observed app operations without polling and does not fabricate breaking-variant failures', async t => {
  const f = await setup(t, { dwellMs: 1 });
  const initial = await f.manager.create({ variant: 'breaking', label: 'Demo' });
  const complete = await until(f.manager, initial.id, state => state.status === 'completed' && !state.busy);
  assert.equal(complete.automation.step, 7);
  assert.equal(complete.phase, 'rollback');
  assert.equal(complete.apps.right.release, 'v1');
  assert.equal(complete.apps.right.instanceId, 'app-right-replacement');
  assert.equal(complete.apps.right.databaseId, 'database-left');
  assert.equal(complete.events.filter(event => event.outcome === 'failed').length, 0);
  assert.equal(f.requests.filter(request => request.path === '/admin/read').length, 8);
  assert.equal(f.requests.filter(request => request.path === '/admin/write-session').length, 1);
  const migrations = f.requests.filter(request => request.path === '/admin/migrate');
  assert.deepEqual(migrations.map(request => [request.side, request.body?.direction]), [['right', 'up'], ['left', 'up'], ['left', 'down']]);
});

test('distinct published commits drive clone and real rollback checkout; app env does not select the implementation', async t => {
  for (const variant of ['breaking', 'compatible'] as const) {
    const f = await setup(t, { dwellMs: 1, sourceRefs });
    const initial = await f.manager.create({ variant, label: 'Demo' });
    const complete = await until(f.manager, initial.id, state => state.status === 'completed' && !state.busy);
    const initialClones = f.commands.filter(command => command.command.includes('git clone'));
    assert.equal(initialClones.length, 2);
    assert(initialClones.find(command => command.side === 'left')!.command.includes(`checkout --detach '${sourceRefs.base}'`));
    assert(initialClones.find(command => command.side === 'right')!.command.includes(`checkout --detach '${sourceRefs[variant]}'`));
    const rollback = f.commands.find(command => command.command.includes('kill -TERM'))!;
    assert.equal(rollback.side, 'right');
    assert(rollback.command.includes(`checkout --detach '${sourceRefs.base}'`));
    assert(rollback.command.includes('rev-parse HEAD'));
    assert.equal(complete.apps.right.sourceRef, sourceRefs.base);
    assert.equal(complete.apps.right.release, 'v1');
    assert.equal(complete.apps.right.instanceId, 'app-right-replacement');
    assert.equal(complete.apps.right.databaseId, 'database-left');
    assert(f.uploads.filter(file => file.path === 'runtime/app.env').every(file => !file.content.includes('GECCO_RELEASE=')));
    assert.equal(f.requests.filter(request => request.path === '/admin/initialize').length, 2);
  }
});

test('pause allows an observed read; resume continues the same journey cursor', async t => {
  const f = await setup(t);
  const initial = await f.manager.create({ variant: 'compatible', label: 'Demo' });
  await until(f.manager, initial.id, state => state.status === 'running' && !state.busy);
  const paused = await f.manager.control(initial.id, { action: 'pause' });
  assert.equal(paused.status, 'paused');
  const pending = await f.manager.control(initial.id, { action: 'read-both' });
  assert.equal(pending.busy, true);
  const read = await until(f.manager, initial.id, state => state.status === 'paused' && !state.busy);
  assert.equal(read.automation.step, 0);
  assert.equal(read.apps.left.observation?.note, 'An observed fixture note');
  assert.equal((await f.manager.control(initial.id, { action: 'play' })).status, 'running');
  await assert.rejects(f.manager.control(initial.id, { action: 'deploy' }), hasStatus(409));
  await assert.rejects(f.manager.control(initial.id, { action: 'pause', command: 'arbitrary' }), hasStatus(400));
});

test('saved active pair on coordinator restart is closed using its identity without rerunning setup', async t => {
  const f = await setup(t);
  const initial = await f.manager.create({ variant: 'compatible', label: 'Demo' });
  await until(f.manager, initial.id, state => state.status === 'running' && !state.busy);
  await f.manager.control(initial.id, { action: 'pause' });
  const record = await readFile(join(f.stateDirectory, `${initial.id}.json`));
  await f.manager.closeAll();
  // Restore a durable pre-crash fixture after stopping this test's first coordinator.
  await writeFile(join(f.stateDirectory, `${initial.id}.json`), record);
  await writeFile(join(f.stateDirectory, 'active.json'), JSON.stringify({ id: initial.id }));
  const before = { creates: f.creates.length, commands: f.commands.length, closes: f.closes.length };
  const restarted = createCloudManager(f.options);
  try {
    const closed = await until(restarted, initial.id, state => state.status === 'closed');
    assert.match(closed.error!, /coordinator restarted/i);
    assert.equal(f.creates.length, before.creates);
    assert.equal(f.commands.length, before.commands);
    assert.equal(f.closes.length, before.closes + 1);
    assert.equal(closed.apps.left.previewUrl, undefined);
  } finally {
    // Finish this second manager's final persist before setup's hook removes the shared directory.
    await restarted.closeAll();
  }
});

test('HTTP 200 with an inconclusive migration stops the journey before reporting deployment', async t => {
  const f = await setup(t, { dwellMs: 1 });
  f.response((side, path) => side === 'left' && path === '/admin/migrate' ? Response.json({ snapshot: f.state.left,
    outcome: 'inconclusive', error: { name: 'Error', message: 'actual migration diagnostic', code: '42601' },
    trace: [{ sql: 'fixture failed migration', error: { code: '42601' } }] }) : undefined);
  const initial = await f.manager.create({ variant: 'breaking', label: 'Demo' });
  const stopped = await until(f.manager, initial.id, state => ['failed', 'closed', 'completed'].includes(state.status) && !state.busy);
  assert.notEqual(stopped.status, 'completed');
  assert.equal(stopped.phase, 'baseline');
  assert.equal(f.requests.filter(request => request.path === '/admin/write-session').length, 0);
  assert(!stopped.events.some(event => event.title === 'Release deployed into the shared database'));
  assert(JSON.stringify(stopped.events).includes('actual migration diagnostic'));
});

test('actual app read failure remains evidence even for compatible variant; transport failure remains inconclusive', async t => {
  const f = await setup(t, { dwellMs: 1 });
  f.response((side, path) => path === '/admin/read' ? Response.json({ snapshot: { ...f.state[side], observation: {
    outcome: 'failed', error: { message: 'observed database failure', code: '42703' }, observedAt: '2026-09-10T12:00:00Z' } },
    outcome: 'failed', trace: [{ sql: 'fixture read', error: { code: '42703' } }] }) : undefined);
  const initial = await f.manager.create({ variant: 'compatible', label: 'Demo' });
  const complete = await until(f.manager, initial.id, state => state.status === 'completed' && !state.busy);
  assert.equal(complete.events.filter(event => event.outcome === 'failed').length, 4);
  assert.equal(complete.apps.left.observation?.error, 'observed database failure');
  assert.equal(complete.apps.left.observation?.at, '2026-09-10T12:00:00Z');
  const disconnected = await setup(t, { dwellMs: 1 });
  disconnected.response((_side, path) => path === '/admin/read' ? new Response('unavailable', { status: 503 }) : undefined);
  const next = await disconnected.manager.create({ variant: 'breaking', label: 'Demo' });
  const failed = await until(disconnected.manager, next.id, state => state.status === 'failed' && !state.busy);
  assert.equal(failed.events.filter(event => event.outcome === 'failed').length, 0);
  assert(failed.events.some(event => event.outcome === 'inconclusive'));
  assert.equal(failed.automation.step, 0);
});

test('pause during an accepted read waits for that step and prevents later structural actions', async t => {
  const f = await setup(t, { dwellMs: 1 });
  const started = deferred<void>(), gate = deferred<void>();
  f.response(async (side, path) => {
    if (path !== '/admin/read') return undefined;
    if (side === 'left') { started.resolve(); await gate.promise; }
    return Response.json({ snapshot: f.state[side], outcome: 'passed', trace: [] });
  });
  const initial = await f.manager.create({ variant: 'breaking', label: 'Demo' });
  await until(f.manager, initial.id, state => state.busy && state.automation.action === 'read-both');
  await started.promise;
  const pausing = await f.manager.control(initial.id, { action: 'pause' });
  assert.equal(pausing.busy, true);
  assert.equal(pausing.status, 'running');
  gate.resolve();
  const paused = await until(f.manager, initial.id, state => state.status === 'paused' && !state.busy);
  assert.equal(paused.automation.step, 1);
  assert.equal(paused.phase, 'baseline');
  assert.equal(f.requests.filter(request => request.side === 'left' && request.path === '/admin/migrate').length, 0);
});

test('cloud HTTP API returns 202, rejects foreign requests and arbitrary input before cloud work, and reload does not cancel accepted work', async t => {
  const f = await setup(t);
  const started = deferred<void>(), gate = deferred<void>();
  f.ensure(async () => { started.resolve(); await gate.promise; });
  const app = createApp({ cloud: f.manager, runsDirectory: join(f.stateDirectory, 'runs'),
    specimen: () => { throw new Error('unused fixture route'); },
    rehearse: async () => { throw new Error('unused fixture route'); },
    analysis: { health: async () => ({ available: false, provider: 'test', model: null }), analyze: async () => { throw new Error('unused fixture route'); } } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { gate.resolve(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/cloud`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ variant: 'breaking', label: 'Demo' }, { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post({ variant: 'breaking', label: 'Demo', command: 'arbitrary' })).status, 400);
  assert.equal((await post({ variant: 'breaking', label: 'x'.repeat(2000) })).status, 413);
  assert.equal(f.creates.length, 0);
  const accepted = await post({ variant: 'breaking', label: 'Demo' });
  assert.equal(accepted.status, 202);
  const initial = await accepted.json() as CloudSnapshot;
  assert.equal(initial.status, 'provisioning');
  await started.promise;
  assert.equal((await fetch(`${base}/api/cloud/${initial.id}`)).status, 200);
  assert.equal(f.closes.length, 0);
  const closing = await fetch(`${base}/api/cloud/${initial.id}`, { method: 'DELETE' });
  assert.equal(closing.status, 202);
  gate.resolve();
  await until(f.manager, initial.id, state => state.status === 'closed');
  assert.equal(f.creates.length, 1);
});
