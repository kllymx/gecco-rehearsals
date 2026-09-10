import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createDaytonaProvider, DaytonaProviderError, type DaytonaClient, type DaytonaProviderOptions,
  type DaytonaSandbox } from '../server/daytona-provider.js';

// No Daytona client is instantiated: these tests make no network or cloud calls.
const experiment = 'experiment-0001';
const output = (result = 'complete', exitCode = 0) => ({ result, exitCode, artifacts: { stdout: result } });
const hasCode = (code: DaytonaProviderError['code']) => (error: unknown) => error instanceof DaytonaProviderError && error.code === code;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function mockClient() {
  const sandboxes = new Map<string, DaytonaSandbox>();
  const creates: Array<Parameters<DaytonaClient['create']>[0]> = [];
  const commands: Array<{ id: string; command: string; cwd?: string; timeout?: number }> = [];
  const uploads: Array<{ id: string; files: Array<{ source: string | Buffer; destination: string }> }> = [];
  const stops: string[] = [], deletes: string[] = [];
  let execute: DaytonaSandbox['process']['executeCommand'] = async () => output();
  let create: ((sandbox: DaytonaSandbox) => Promise<DaytonaSandbox>) | undefined;
  let stop: ((sandbox: DaytonaSandbox) => Promise<void>) | undefined;
  let remove: ((sandbox: DaytonaSandbox) => Promise<void>) | undefined;
  let upload: (() => Promise<void>) | undefined;
  const client: DaytonaClient = {
    async get(idOrName) {
      const sandbox = [...sandboxes.values()].find(value => value.id === idOrName || value.name === idOrName);
      if (!sandbox) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return sandbox;
    },
    async create(params, options) {
      assert(options.timeout > 0);
      creates.push(params);
      const sandbox: DaytonaSandbox = {
        id: `sandbox-${creates.length}`, name: params.name!, labels: params.labels!, public: params.public!,
        cpu: params.resources!.cpu!, memory: params.resources!.memory!, disk: params.resources!.disk!, state: 'started',
        process: { async executeCommand(command, cwd, env, timeout) {
          commands.push({ id: sandbox.id, command, cwd, timeout });
          return execute(command, cwd, env, timeout);
        } },
        fs: { async uploadFiles(files) { uploads.push({ id: sandbox.id, files }); await upload?.(); } },
        async stop() { stops.push(sandbox.id); if (stop) await stop(sandbox); else sandbox.state = 'stopped'; },
        async delete(_timeout, wait) { assert.equal(wait, true); deletes.push(sandbox.id);
          if (remove) await remove(sandbox); else sandboxes.delete(sandbox.id); },
        async getPreviewLink(port) { return { sandboxId: sandbox.id, url: `https://${port}-${sandbox.id}.proxy.daytona.test/`, token: 'private-test-token' }; },
        async getSignedPreviewUrl(port, expiry) { return { sandboxId: sandbox.id, port, token: 'test-signature', url: `https://${port}-${sandbox.id}.proxy.daytona.test/?signature=test-${expiry}` }; },
      };
      sandboxes.set(sandbox.id, sandbox);
      return create ? create(sandbox) : sandbox;
    },
  };
  return { client, sandboxes, creates, commands, uploads, stops, deletes,
    execute: (value: typeof execute) => { execute = value; },
    create: (value: typeof create) => { create = value; },
    stop: (value: typeof stop) => { stop = value; },
    remove: (value: typeof remove) => { remove = value; },
    upload: (value: typeof upload) => { upload = value; },
  };
}
async function fixture(t: TestContext, overrides: Partial<DaytonaProviderOptions> = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'gecco-daytona-provider-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const mock = mockClient();
  const options: DaytonaProviderOptions = { client: mock.client, stateDirectory, namespace: 'gecco-public-test',
    image: 'node:22-bookworm', user: 'root', ...overrides };
  return { ...mock, stateDirectory, options, provider: createDaytonaProvider(options), reload: () => createDaytonaProvider(options) };
}

test('a pair uses private bounded resources, deterministic ownership, TTL, and survives provider restart without more creates', async t => {
  const f = await fixture(t);
  const pair = await f.provider.ensurePair(experiment);
  assert.equal(f.creates.length, 2);
  assert.notEqual(pair.left.id, pair.right.id);
  for (const params of f.creates) {
    assert.equal(params.public, false);
    assert.equal(params.image, 'node:22-bookworm');
    assert.equal(params.user, 'root');
    assert.deepEqual(params.resources, { cpu: 1, memory: 2, disk: 3 });
    assert.equal(params.ttlMinutes, 60);
    assert.equal(params.autoStopInterval, 15);
    assert.equal(params.autoDeleteInterval, 0);
    assert.match(params.name!, /^gecco-[a-f0-9]{32}-(left|right)$/);
    assert.equal(params.labels!['gecco-provider'], 'paired-app-v1');
  }
  assert.deepEqual(await f.reload().ensurePair(experiment), pair);
  assert.equal(f.creates.length, 2);
  await assert.rejects(f.provider.ensurePair('experiment-0002'), hasCode('capacity'));
});

test('lost create response reconciles existing sandbox; unresolved create is never replayed and keeps the capacity slot', async t => {
  const f = await fixture(t);
  f.create(async sandbox => { if (f.creates.length === 1) throw new Error('lost response with sensitive transport detail'); return sandbox; });
  assert.equal((await f.provider.ensurePair(experiment)).right.state, 'started');
  assert.equal(f.creates.length, 2);
  const uncertain = await fixture(t);
  uncertain.create(async sandbox => { uncertain.sandboxes.delete(sandbox.id); throw new Error('lost response'); });
  await assert.rejects(uncertain.provider.ensurePair(experiment), hasCode('uncertain'));
  await assert.rejects(uncertain.reload().ensurePair(experiment), hasCode('uncertain'));
  assert.equal(uncertain.creates.length, 1);
  const state = await uncertain.provider.inspectPair(experiment);
  assert.equal(state.left.state, 'uncertain');
  assert.equal(state.right.state, 'not-created');
  const cleanup = await uncertain.provider.cleanupPair(experiment);
  assert.equal(cleanup.complete, false);
  assert.equal(cleanup.sides[0].deletedVerified, false);
  assert.equal(cleanup.sides[1].state, 'never-created');
  await assert.rejects(uncertain.provider.ensurePair('experiment-0002'), hasCode('capacity'));
});

test('name collision with foreign labels cannot be adopted or deleted', async t => {
  const f = await fixture(t);
  await f.provider.ensurePair(experiment);
  f.sandboxes.get('sandbox-1')!.labels = { 'gecco-owner': 'another-owner' };
  await assert.rejects(f.reload().ensurePair(experiment), hasCode('ownership'));
  const result = await f.provider.cleanupPair(experiment);
  assert.equal(result.complete, false);
  assert.equal(result.sides[0].state, 'uncertain');
  assert(!f.stops.includes('sandbox-1'));
  assert(!f.deletes.includes('sandbox-1'));
  assert(f.sandboxes.has('sandbox-1'));
});

test('cleanup verifies delete and preserves capacity until observation confirms deletion', async t => {
  const f = await fixture(t);
  await f.provider.ensurePair(experiment);
  f.remove(async () => { /* Provider accepted a delete but has not removed anything. */ });
  const pending = await f.provider.cleanupPair(experiment);
  assert.equal(pending.complete, false);
  assert(pending.sides.every(side => side.stoppedVerified && !side.deletedVerified));
  await assert.rejects(f.provider.ensurePair('experiment-0002'), hasCode('capacity'));
  f.remove(undefined);
  const complete = await f.provider.cleanupPair(experiment);
  assert.equal(complete.complete, true);
  assert(complete.sides.every(side => side.state === 'deleted' && side.deletedVerified));
  const deleteCount = f.deletes.length;
  assert.equal((await f.reload().cleanupPair(experiment)).complete, true);
  assert.equal(f.deletes.length, deleteCount);
  await assert.rejects(f.provider.ensurePair(experiment), hasCode('closed'));
  await f.provider.ensurePair('experiment-0002');
  assert.equal(f.creates.length, 4);
});

test('local command timeout preserves remote uncertainty and never labels a late response as cancellation', async t => {
  const f = await fixture(t);
  await f.provider.ensurePair(experiment);
  const started = deferred<void>(), command = deferred<ReturnType<typeof output>>();
  f.execute(async () => { started.resolve(); return command.promise; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = { operationId: 'operation-0001', command: 'trusted operation', timeoutSeconds: 1 };
  const running = f.provider.execute(experiment, 'left', input);
  const rejected = assert.rejects(running, hasCode('uncertain'));
  await started.promise;
  assert.equal(f.provider.pendingOperations(), 1);
  t.mock.timers.tick(6001);
  await rejected;
  assert.equal(f.provider.pendingOperations(), 1);
  command.resolve(output('late actual completion'));
  await command.promise;
  await assert.rejects(f.reload().execute(experiment, 'left', input), hasCode('uncertain'));
  assert.equal(f.commands.length, 1);
  assert.equal(f.provider.pendingOperations(), 0);
});

test('auto-delete during stop counts as verified deletion; an owned privacy/resource violation can still be cleaned', async t => {
  const f = await fixture(t);
  await f.provider.ensurePair(experiment);
  f.sandboxes.get('sandbox-1')!.public = true;
  f.sandboxes.get('sandbox-2')!.memory = 4;
  await assert.rejects(f.provider.inspectPair(experiment), hasCode('configuration'));
  f.stop(async sandbox => { f.sandboxes.delete(sandbox.id); throw new Error('response lost after auto-delete'); });
  const result = await f.provider.cleanupPair(experiment);
  assert.equal(result.complete, true);
  assert(result.sides.every(side => side.deletedVerified));
  assert.equal(f.deletes.length, 0);
});

test('commands preserve real exit codes, truncate retained output, and replay saved results without executing again', async t => {
  const f = await fixture(t, { limits: { maxOutputBytes: 12, operationSeconds: 300 } });
  await f.provider.ensurePair(experiment);
  f.execute(async () => output('x'.repeat(100), 7));
  const input = { operationId: 'operation-0001', command: 'trusted build', cwd: '/home/daytona/gecco/repo', timeoutSeconds: 300 };
  const result = await f.provider.execute(experiment, 'left', input);
  assert.equal(result.exitCode, 7);
  assert.equal(result.output, 'x'.repeat(12));
  assert.equal(result.outputBytes, 100);
  assert.equal(result.outputTruncated, true);
  assert.equal(f.commands[0].timeout, 300);
  assert.deepEqual(await f.reload().execute(experiment, 'left', input), result);
  assert.equal(f.commands.length, 1);
  await assert.rejects(f.provider.execute(experiment, 'left', { ...input, command: 'different command' }), hasCode('invalid-input'));
});

test('an ambiguous command cannot be replayed or followed by another write after restart', async t => {
  const f = await fixture(t);
  await f.provider.ensurePair(experiment);
  f.execute(async () => { throw new Error('sensitive provider diagnostic'); });
  const input = { operationId: 'operation-0001', command: 'trusted mutation' };
  await assert.rejects(f.provider.execute(experiment, 'left', input), hasCode('uncertain'));
  const reloaded = f.reload();
  await assert.rejects(reloaded.execute(experiment, 'left', input), hasCode('uncertain'));
  await assert.rejects(reloaded.execute(experiment, 'left', { ...input, operationId: 'operation-0002' }), hasCode('uncertain'));
  await assert.rejects(reloaded.uploadFiles(experiment, 'left', [{ path: 'app.js', bytes: Buffer.from('code') }]), hasCode('uncertain'));
  assert.equal(f.commands.length, 1);
  assert.equal((await reloaded.inspectPair(experiment)).left.state, 'started');
  assert.equal((await reloaded.cleanupPair(experiment)).complete, true);
});

test('accepted command excludes overlapping writes and cleanup, while inspection remains available', async t => {
  const f = await fixture(t);
  await f.provider.ensurePair(experiment);
  const started = deferred<void>(), command = deferred<ReturnType<typeof output>>();
  f.execute(async () => { started.resolve(); return command.promise; });
  const running = f.provider.execute(experiment, 'left', { operationId: 'operation-0001', command: 'trusted operation' });
  await started.promise;
  await assert.rejects(f.provider.execute(experiment, 'left', { operationId: 'operation-0002', command: 'second' }), hasCode('busy'));
  await assert.rejects(f.provider.cleanupPair(experiment), hasCode('busy'));
  assert.equal((await f.provider.inspectPair(experiment)).left.state, 'started');
  command.resolve(output());
  await running;
  assert.equal((await f.provider.cleanupPair(experiment)).complete, true);
});

test('trusted uploads enforce path and byte bounds and preserve uncertainty without exposing raw errors', async t => {
  const f = await fixture(t);
  await f.provider.ensurePair(experiment);
  for (const path of ['../escape', '/absolute', '.', 'a/../escape', 'bad\0name'])
    await assert.rejects(f.provider.uploadFiles(experiment, 'left', [{ path, bytes: Buffer.from('file') }]), hasCode('invalid-input'));
  await assert.rejects(f.provider.uploadFiles(experiment, 'left', [{ path: 'huge', bytes: Buffer.alloc(1024 * 1024 + 1) }]), hasCode('invalid-input'));
  const result = await f.provider.uploadFiles(experiment, 'left', [{ path: "repo/a'b.js", bytes: Buffer.from('hello') }]);
  assert.deepEqual(result, { files: 1, bytes: 5 });
  assert.equal(f.uploads[0].files[0].destination, "/home/daytona/gecco/repo/a'b.js");
  assert.equal(f.commands[0].command, "mkdir -p -- '/home/daytona/gecco/repo'");
  f.upload(async () => { throw new Error('secret-transport-diagnostic'); });
  await assert.rejects(f.provider.uploadFiles(experiment, 'right', [{ path: 'app.js', bytes: Buffer.from('hello') }]), error =>
    hasCode('uncertain')(error) && !(error as Error).message.includes('secret-transport'));
  await assert.rejects(f.reload().execute(experiment, 'right', { operationId: 'operation-0001', command: 'cannot follow unknown upload' }), hasCode('uncertain'));
});

test('private preview tokens stay server-only and out of persisted records; signed frames have bounded expiry', async t => {
  const f = await fixture(t);
  await f.provider.ensurePair(experiment);
  const preview = await f.provider.preview(experiment, 'left', 3000);
  assert.equal(preview.headers['x-daytona-preview-token'], 'private-test-token');
  assert.equal(preview.headers['x-daytona-skip-preview-warning'], 'true');
  assert.match(preview.url, /^https:/);
  const signed = await f.provider.signedPreview(experiment, 'left', 3000);
  assert.match(signed.url, /signature=test-3600/);
  await assert.rejects(f.provider.signedPreview(experiment, 'left', 3000, 3601), hasCode('invalid-input'));
  await assert.rejects(f.provider.preview(experiment, 'left', 22222), hasCode('invalid-input'));
  const paths = await readdir(f.stateDirectory, { recursive: true });
  const persisted = await Promise.all(paths.filter(path => path.endsWith('.json')).map(path => readFile(join(f.stateDirectory, path), 'utf8')));
  assert(!persisted.join('').includes('private-test-token'));
  assert(!persisted.join('').includes('signature='));
  assert(!JSON.stringify(await f.provider.inspectPair(experiment)).includes('token'));
});

test('configuration changes and invalid bounds fail without new allocation', async t => {
  const f = await fixture(t);
  assert.throws(() => createDaytonaProvider({ ...f.options, limits: { cpu: 2 } }), hasCode('invalid-input'));
  assert.throws(() => createDaytonaProvider({ ...f.options, user: 'root; command' }), hasCode('invalid-input'));
  await f.provider.ensurePair(experiment);
  await assert.rejects(createDaytonaProvider({ ...f.options, user: 'node' }).ensurePair(experiment), hasCode('configuration'));
  await assert.rejects(f.provider.execute(experiment, 'left', { operationId: 'operation-0001', command: 'trusted', cwd: '/etc' }), hasCode('invalid-input'));
  assert.equal(f.creates.length, 2);
});
