import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import type { AnalysisResult, RehearsalRun, Specimen, Variant } from '../shared/contracts.js';
import { createApp } from '../server/app.js';
import { RunStore } from '../server/store.js';
import { analysisPrompt, createCodexAnalysis, parseAnalysis } from '../server/ai.js';
import { ProcessFailure, runProcess } from '../server/process.js';

const specimen: Specimen = { id: 'test-specimen', title: 'A public test specimen', description: 'Test fixture',
  contract: 'Preserve writes on rollback.', currentRelease: 'v1', proposedRelease: 'v2',
  files: [{ path: 'migration.sql', before: 'before-only', breaking: 'breaking-only', compatible: 'compatible-only' }] };
const unavailable: AnalysisResult = { status: 'unavailable', provider: 'test provider', model: null,
  generatedAt: '2026-09-10T12:00:00Z', summary: 'Unavailable', hypotheses: [], suggestedFix: '', error: 'No test inference.' };
const run = (variant: Variant, id = 'test-run-0001'): RehearsalRun => ({ id, variant, startedAt: '2026-09-10T12:00:00Z',
  completedAt: '2026-09-10T12:00:01Z', engine: 'pglite-postgres', sourceDigest: 'test-source', fixtureDigest: 'test-fixture',
  contract: specimen.contract, scenarios: [], summary: 'API transport test only.', durationMs: 1, scope: 'Test fixture' });

async function setup(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gecco-api-test-'));
  const app = createApp({ specimen: () => specimen, rehearse: async variant => run(variant),
    analysis: { health: async () => ({ available: false, provider: 'test provider', model: null }), analyze: async () => unavailable },
    runsDirectory: join(directory, 'runs'), ...overrides });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return { ...app, base, directory, cleanup: async () => {
    app.abortAll();
    app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('API serves specimen, keeps unavailable AI honest, and persists a completed run across store reload', async () => {
  const app = await setup();
  try {
    assert.deepEqual(await (await fetch(`${app.base}/api/specimen`)).json(), specimen);
    assert.equal((await (await fetch(`${app.base}/api/health`)).json()).ai.available, false);
    assert.deepEqual(await (await post(app.base, '/api/analyze', { variant: 'breaking' })).json(), unavailable);
    const executed = await post(app.base, '/api/rehearse', { variant: 'breaking' });
    assert.equal(executed.status, 200);
    assert.deepEqual(await executed.json(), run('breaking'));
    assert.deepEqual(await (await fetch(`${app.base}/api/runs`)).json(), [run('breaking')]);
    assert.deepEqual(await (await fetch(`${app.base}/api/runs/test-run-0001`)).json(), run('breaking'));
    assert.deepEqual(await new RunStore(join(app.directory, 'runs')).get('test-run-0001'), run('breaking'));
    assert.equal((await fetch(`${app.base}/api/runs/missing-0000`)).status, 404);
  } finally { await app.cleanup(); }
});

test('API rejects arbitrary prompts, variants, oversized bodies, foreign origins and rebinding hosts before executing', async () => {
  let calls = 0;
  const app = await setup({ rehearse: async variant => { calls++; return run(variant); } });
  try {
    for (const body of [{ variant: 'custom' }, { variant: 'breaking', prompt: 'run me' }, [], null]) {
      assert.equal((await post(app.base, '/api/rehearse', body)).status, 400);
    }
    assert.equal((await post(app.base, '/api/rehearse', { variant: 'breaking', padding: 'x'.repeat(2000) })).status, 413);
    assert.equal((await post(app.base, '/api/rehearse', { variant: 'breaking' }, { origin: 'https://attacker.example' })).status, 403);
    const rebindingStatus = await new Promise<number | undefined>((resolveStatus, reject) => {
      const request = httpRequest(`${app.base}/api/rehearse`, { method: 'POST', headers: {
        host: 'rebind.example', 'content-type': 'application/json',
      } }, response => { response.resume(); resolveStatus(response.statusCode); });
      request.on('error', reject);
      request.end(JSON.stringify({ variant: 'breaking' }));
    });
    assert.equal(rebindingStatus, 403);
    assert.equal((await post(app.base, '/api/rehearse', { variant: 'breaking' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await fetch(`${app.base}/api/rehearse`, { method: 'POST', body: '{}' })).status, 415);
    assert.equal(calls, 0);
  } finally { await app.cleanup(); }
});

test('concurrent rehearsal is rejected and disconnect aborts the worker signal', async () => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const aborted = new Promise<void>(resolve => { markAborted = resolve; });
  const app = await setup({ rehearse: async (_variant, signal) => {
    markStarted();
    return new Promise<RehearsalRun>((_resolve, reject) => signal.addEventListener('abort', () => {
      markAborted(); reject(new ProcessFailure('cancelled'));
    }, { once: true }));
  } });
  try {
    const controller = new AbortController();
    const pending = fetch(`${app.base}/api/rehearse`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variant: 'breaking' }), signal: controller.signal }).catch(() => undefined);
    await started;
    assert.equal((await post(app.base, '/api/rehearse', { variant: 'compatible' })).status, 429);
    controller.abort();
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation did not arrive')), 2000).unref())]);
    await pending;
    assert.deepEqual(await (await fetch(`${app.base}/api/runs`)).json(), []);
  } finally { await app.cleanup(); }
});

test('static server exposes built assets and excludes repository paths and unknown assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gecco-static-test-'));
  await mkdir(join(directory, 'dist'));
  await writeFile(join(directory, 'dist', 'index.html'), '<main>Demo</main>');
  await writeFile(join(directory, 'secret.txt'), 'private');
  const app = await setup({ distDirectory: join(directory, 'dist') });
  try {
    const response = await fetch(app.base);
    assert.equal(await response.text(), '<main>Demo</main>');
    assert(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.equal((await fetch(`${app.base}/%2e%2e/secret.txt`)).status, 404);
    assert.equal((await fetch(`${app.base}/server/index.ts`)).status, 404);
  } finally { await app.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('analysis input includes only selected public variant and contract, and validator rejects duplicate or invented scenario IDs', () => {
  const prompt = analysisPrompt(specimen, 'breaking');
  assert(prompt.includes(specimen.contract));
  assert(prompt.includes('breaking-only'));
  assert(!prompt.includes('compatible-only'));
  const value = { summary: 'Predictions only', hypotheses: ['control', 'upgrade', 'mixed', 'rollback'].map(scenarioId => ({
    scenarioId, risk: 'A hypothesis', rationale: 'The source says so' })), suggestedFix: 'Preserve the legacy field.' };
  assert.deepEqual(parseAnalysis(value), value);
  assert.throws(() => parseAnalysis({ ...value, hypotheses: [...value.hypotheses.slice(0, 3), value.hypotheses[0]] }));
  assert.throws(() => parseAnalysis({ ...value, hypotheses: [{ scenarioId: 'invented', risk: 'bad', rationale: 'bad' }] }));
});

test('missing CLI returns unavailable with no canned hypotheses', async () => {
  const ai = createCodexAnalysis({ cwd: process.cwd(), command: '/gecco-test-not-a-cli' });
  assert.equal((await ai.health()).available, false);
  const result = await ai.analyze(specimen, 'breaking');
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.hypotheses, []);
});

test('process limits kill timed out work, cancel on abort, and bound captured output', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: process.cwd(), timeoutMs: 50,
  }), (error: unknown) => error instanceof ProcessFailure && error.kind === 'timeout');
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
    cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 100,
  }), (error: unknown) => error instanceof ProcessFailure && error.kind === 'output-limit');
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: process.cwd(), timeoutMs: 1000, signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ProcessFailure && error.kind === 'cancelled');
});
