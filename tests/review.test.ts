import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CloudRevision, CloudSnapshot } from '../shared/cloud.js';
import type { ReviewPullRequest, ReviewState } from '../shared/review.js';
import type { CloudManager } from '../server/cloud.js';
import { createReviewManager, failureEvidence, reviewOutcome, ReviewApiError, type ReviewManager } from '../server/review.js';
import { ProviderQuotaRejected, QUOTA_REJECTION_MESSAGE, type RepairBackend, type RepairInput } from '../server/repair.js';
import { ProcessFailure } from '../server/process.js';

const base = 'a'.repeat(40), head = 'b'.repeat(40), commit = 'c'.repeat(40);
const pr: ReviewPullRequest = { url: 'https://github.com/kllymx/gecco-rehearsals/pull/1', number: 1, title: 'Add a launch board', baseRef: base, headRef: head, headBranch: 'codex/demo-pr-launch-board' };
function completed(revision: CloudRevision, fails = false): CloudSnapshot {
  const titles = ['Both versions tested independently', 'The new launch board works on its own',
    'Release deployed into the shared database', 'Old and new code tested against release data',
    'The new app created a real session', 'The new launch board saved into the release database', 'Old and new code tested against release data'];
  const events = titles.map((title, index) => ({ id: randomUUID(), at: new Date().toISOString(), title, detail: 'Actual operation receipt',
    outcome: (fails && [3, 6].includes(index) ? 'failed' : 'passed') as 'failed' | 'passed',
    evidence: { left: { outcome: fails && [3, 6].includes(index) ? 'failed' : 'passed', error: fails ? { message: 'column session_payload does not exist' } : undefined }, right: { outcome: 'passed' } } }));
  return { id: randomUUID(), provider: 'daytona', status: 'completed', variant: 'breaking', label: 'Launch', phase: 'rollout',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), revision: 20,
    progress: { stage: 'Done', detail: '' }, repository: 'https://github.com/kllymx/gecco-rehearsals',
    change: { title: pr.title, baseRef: revision.baseRef, proposedRef: revision.headRef }, pullRequest: revision.pullRequest,
    apps: { left: { side: 'left', state: 'running', release: 'v1', entrypoint: 'apps/fieldnotes/release.ts', sourceRef: base,
      previewUrl: 'https://preview.example/?token=private', observation: { outcome: fails ? 'failed' : 'passed', error: fails ? 'column session_payload does not exist' : undefined } },
      right: { side: 'right', state: 'running', release: 'v2-breaking', entrypoint: 'apps/fieldnotes/release.ts', sourceRef: revision.headRef, observation: { outcome: 'passed' } } },
    events, automation: { step: 7, total: 7 }, busy: false };
}
async function setup(t: TestContext, changes: Partial<RepairBackend> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gecco-review-test-'));
  const managers: ReviewManager[] = [];
  t.after(async () => { managers.forEach(manager => manager.shutdown()); await new Promise(resolve => setTimeout(resolve, 20)); await rm(directory, { recursive: true, force: true }); });
  const calls: string[] = [], states = new Map<string, CloudSnapshot>();
  let activeId: string | undefined, remote = head, firstFailure = true, captured: RepairInput | undefined;
  const cloud: CloudManager = {
    async status() { return { configured: true, activeId, repository: 'https://github.com/kllymx/gecco-rehearsals', sourceRef: base }; },
    async create(_input, revision) { assert.ok(revision); calls.push(`create:${revision.headRef}`); const state = completed(revision, firstFailure && states.size === 0); states.set(state.id, state); activeId = state.id; return structuredClone(state); },
    async snapshot(id) { assert.ok(states.has(id)); return structuredClone(states.get(id)!); },
    async control() { throw new Error('Cloud creation already starts autonomy'); },
    async close(id) { calls.push('close'); const state = states.get(id)!; state.status = 'closed'; state.cleanup = { complete: true }; activeId = undefined; return structuredClone(state); },
    async closeAll() {},
  };
  const backend: RepairBackend = {
    async resolvePr() { calls.push('resolve'); return { ...pr, headRef: remote }; },
    async sources() { calls.push('sources'); return { base: [{ path: 'base-reader', content: 'old contract' }], head: [{ path: 'release.ts', content: 'actual proposed source' }] }; },
    async generate(input) { calls.push('generate'); captured = input; return { summary: 'Preserve the deployed reader contract', files: [], reportedModel: 'gpt-6-astra', generatedAt: new Date().toISOString() }; },
    async prepare() { calls.push('prepare'); return { commitSha: commit, validation: 'Immutable tests passed' }; },
    async remoteHead() { calls.push('remote'); return remote; },
    async push() { calls.push('push'); const saved = JSON.parse(await readFile(join(directory, 'review.json'), 'utf8')); assert.equal(saved.intent.kind, 'push'); assert.equal(saved.intent.commitSha, commit); remote = commit; },
    ...changes,
  };
  const options = { cwd: process.cwd(), stateDirectory: directory, cloud, defaultPrUrl: pr.url, backend, pollMs: 2, cleanupTimeoutMs: 30 };
  const manager = createReviewManager(options); managers.push(manager);
  return { manager, options, managers, calls, states, directory, cloud, backend,
    setRemote(value: string) { remote = value; }, setFirstFailure(value: boolean) { firstFailure = value; },
    captured: () => captured,
    setActive(value: string) { activeId = value; } };
}
async function until(manager: ReviewManager, stage: ReviewState['stage']): Promise<ReviewState> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await manager.status(); if (state.stage === stage) return state;
    if (state.stage === 'inconclusive' && stage !== 'inconclusive') assert.fail(state.message);
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail(`Review never reached ${stage}: ${JSON.stringify(await manager.status())}`);
}
test('accepted PR runs once, Astra patch publishes with durable intent, confirmed deletion precedes fresh exact-commit rerun', async t => {
  const f = await setup(t);
  const accepted = await f.manager.start({ prUrl: pr.url, label: 'Launch' });
  assert.equal(accepted.stage, 'rehearsing');
  await until(f.manager, 'failure_observed');
  assert.equal((await f.manager.fix()).stage, 'generating');
  const result = await until(f.manager, 'verified');
  assert.equal(result.originalRun?.status, 'failed'); assert.equal(result.retestRun?.status, 'passed');
  assert.equal(result.retestRun?.headRef, commit); assert.equal(result.fix?.requestedModel, 'gpt-6-astra');
  assert.ok(result.fix?.commitUrl?.endsWith(commit));
  assert.equal(f.calls.filter(call => call === 'generate').length, 1);
  assert.equal(f.calls.filter(call => call === 'push').length, 1);
  assert.ok(f.calls.indexOf('close') < f.calls.indexOf(`create:${commit}`));
  assert.ok(!JSON.stringify(f.captured()).includes('private'));
  assert.ok(!JSON.stringify(result).includes('preview.example'));
});
test('successful original PR is verified without model inference or a fix option', async t => {
  const f = await setup(t); f.setFirstFailure(false);
  await f.manager.start({ prUrl: pr.url, label: 'Launch' });
  const state = await until(f.manager, 'verified');
  assert.equal(state.originalRun?.status, 'passed'); assert.equal(state.fix, undefined);
  await assert.rejects(f.manager.fix(), error => error instanceof ReviewApiError && error.statusCode === 409);
  assert.ok(!f.calls.includes('generate'));
});
test('invalid URL, extra input, and active cloud pair never resolve or allocate', async t => {
  const f = await setup(t);
  await assert.rejects(f.manager.start({ prUrl: 'https://github.com/other/repo/pull/1', label: 'Launch' }));
  await assert.rejects(f.manager.start({ prUrl: pr.url, label: 'Launch', command: 'bad' }));
  f.setActive('existing');
  await assert.rejects(f.manager.start({ prUrl: pr.url, label: 'Launch' }), error => error instanceof ReviewApiError && error.statusCode === 409);
  assert.deepEqual(f.calls, []);
});
test('stale PR head refuses inference and publication', async t => {
  const f = await setup(t);
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed');
  f.setRemote('d'.repeat(40)); await f.manager.fix();
  assert.match((await until(f.manager, 'inconclusive')).message, /changed/);
  assert.ok(!f.calls.includes('generate')); assert.ok(!f.calls.includes('push'));
});
test('head changes after validation never publish', async t => {
  const f = await setup(t);
  f.backend.prepare = async () => { f.calls.push('prepare'); f.setRemote('d'.repeat(40)); return { commitSha: commit, validation: 'passed' }; };
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed'); await f.manager.fix();
  assert.match((await until(f.manager, 'inconclusive')).message, /changed/);
  assert.ok(!f.calls.includes('push')); assert.ok(!f.calls.includes('close'));
});
test('unknown push response reconciles exact remote SHA once and never pushes again', async t => {
  const f = await setup(t);
  f.backend.push = async () => { f.calls.push('push'); f.setRemote(commit); throw new Error('transport lost'); };
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed'); await f.manager.fix();
  await until(f.manager, 'verified'); assert.equal(f.calls.filter(call => call === 'push').length, 1);
});
test('unknown push with unchanged remote halts and retains intent without cleanup or rerun', async t => {
  const f = await setup(t, { async push() { throw new Error('transport lost'); } });
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed'); await f.manager.fix();
  const state = await until(f.manager, 'inconclusive'); assert.match(state.message, /uncertain/);
  assert.ok(!f.calls.includes('close')); assert.equal(f.states.size, 1);
  const saved = JSON.parse(await readFile(join(f.directory, 'review.json'), 'utf8')); assert.equal(saved.intent.kind, 'push');
  await assert.rejects(f.manager.fix());
});
test('unconfirmed cleanup never creates a new pair', async t => {
  const f = await setup(t);
  f.cloud.close = async id => { f.calls.push('close'); const state = f.states.get(id)!; state.status = 'failed'; state.cleanup = { complete: false }; return state; };
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed'); await f.manager.fix();
  assert.match((await until(f.manager, 'inconclusive')).message, /Deletion/); assert.equal(f.states.size, 1);
});
test('failed fresh rerun stays failed despite successful AI and commit publication', async t => {
  const f = await setup(t); const originalCreate = f.cloud.create;
  f.cloud.create = async (input, revision) => { const state = await originalCreate(input, revision); if (revision!.headRef === commit) { const failure = completed(revision!, true); failure.id = state.id; f.states.set(state.id, failure); return failure; } return state; };
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed'); await f.manager.fix();
  const state = await until(f.manager, 'failed'); assert.equal(state.retestRun?.status, 'failed');
});
test('durable push intent restart reconciles but never replays model, push, or cloud create', async t => {
  const f = await setup(t); await f.manager.status(); f.manager.shutdown(); f.setRemote(commit);
  await writeFile(join(f.directory, 'review.json'), JSON.stringify({ version: 1, state: { stage: 'publishing', defaultPrUrl: pr.url,
    pullRequest: pr, fix: { requestedModel: 'gpt-6-astra', reportedModel: 'gpt-6-astra' }, message: 'Publishing', updatedAt: new Date().toISOString() },
    intent: { kind: 'push', headRef: head, commitSha: commit } }));
  const restored = createReviewManager(f.options); f.managers.push(restored);
  const state = await restored.status(); assert.equal(state.stage, 'inconclusive'); assert.ok(state.fix?.commitUrl?.endsWith(commit));
  assert.deepEqual(f.calls, ['remote']);
});
test('completed immutable event receipts survive transient preview observations; incomplete or missing checks do not pass', () => {
  const state = completed({ baseRef: base, headRef: head, pullRequest: pr });
  state.apps.left.observation = { outcome: 'inconclusive' };
  assert.equal(reviewOutcome(state), 'passed');
  state.events.pop(); assert.equal(reviewOutcome(state), 'inconclusive');
  state.status = 'running'; assert.equal(reviewOutcome(state), 'running');
});
test('failed evidence is bounded and removes URLs, credentials and arbitrary nested traces', () => {
  const state = completed({ baseRef: base, headRef: head, pullRequest: pr }, true);
  state.apps.left.observation!.error = 'SQL failed https://private.example/?token=abc Bearer abc token=xyz';
  state.events[3].evidence = { left: { error: { message: 'column missing' } }, token: 'secret', trace: { headers: { authorization: 'secret' } } };
  const data = JSON.stringify(failureEvidence(state));
  assert.match(data, /column missing/); assert.ok(!data.includes('private.example')); assert.ok(!data.includes('secret')); assert.ok(!data.includes('Bearer abc'));
});
test('definite quota rejection permits only a new explicit repair action and blocks concurrent duplicates', async t => {
  const f = await setup(t);
  let rejectGeneration!: (error: Error) => void, generations = 0;
  f.backend.generate = async () => { generations++; return new Promise((_resolve, reject) => { rejectGeneration = reject; }); };
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed');
  await f.manager.fix(); await assert.rejects(f.manager.fix(), error => error instanceof ReviewApiError && error.statusCode === 409);
  for (let attempt = 0; attempt < 50 && !rejectGeneration; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  rejectGeneration(new ProviderQuotaRejected());
  const rejected = await until(f.manager, 'failure_observed'); assert.equal(rejected.error, QUOTA_REJECTION_MESSAGE);
  await new Promise(resolve => setTimeout(resolve, 20));
  for (let poll = 0; poll < 5; poll++) await f.manager.status();
  assert.equal(generations, 1); assert.equal(f.states.size, 1); assert.ok(!f.calls.includes('push'));
  const saved = JSON.parse(await readFile(join(f.directory, 'review.json'), 'utf8')); assert.equal(saved.intent, undefined);
  f.backend.generate = async () => { generations++; throw new ProviderQuotaRejected(); };
  await f.manager.fix(); await until(f.manager, 'failure_observed'); assert.equal(generations, 2);
});
test('quota rejection also permits a new explicit review only after the old pair is closed', async t => {
  const f = await setup(t, { async generate() { throw new ProviderQuotaRejected(); } });
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed'); await f.manager.fix();
  const rejected = await until(f.manager, 'failure_observed'); await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(f.manager.start({ prUrl: pr.url, label: 'Next' }), /Close the active/);
  await f.cloud.close(rejected.originalRun!.id);
  const next = await f.manager.start({ prUrl: pr.url, label: 'Next' }); assert.notEqual(next.id, rejected.id);
  await until(f.manager, 'verified');
});
test('unknown generation errors keep intent and prohibit explicit retry', async t => {
  const f = await setup(t, { async generate() { throw new Error('unknown response'); } });
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed'); await f.manager.fix();
  await until(f.manager, 'inconclusive');
  await assert.rejects(f.manager.fix());
  const saved = JSON.parse(await readFile(join(f.directory, 'review.json'), 'utf8')); assert.equal(saved.intent.kind, 'generate');
});
test('limit text accompanying partial output remains inconclusive across restart', async t => {
  const detail = "ERROR: You've hit your usage limit.";
  const f = await setup(t, { async generate() { throw new ProcessFailure('exit', detail,
    { stdout: '{"summary":"partial', stderr: detail, complete: true, exitCode: 1, signal: null }); } });
  await f.manager.start({ prUrl: pr.url, label: 'Launch' }); await until(f.manager, 'failure_observed'); await f.manager.fix();
  const failed = await until(f.manager, 'inconclusive'); assert.notEqual(failed.error, QUOTA_REJECTION_MESSAGE);
  await new Promise(resolve => setTimeout(resolve, 20)); f.manager.shutdown();
  const restored = createReviewManager(f.options); f.managers.push(restored);
  assert.equal((await restored.status()).stage, 'inconclusive');
  await assert.rejects(restored.fix());
  assert.equal(JSON.parse(await readFile(join(f.directory, 'review.json'), 'utf8')).intent.kind, 'generate');
});
test('only the exact historical pre-patch quota state recovers on load without model or cloud work', async t => {
  const f = await setup(t); await f.manager.status(); f.manager.shutdown();
  const runId = randomUUID();
  const saved = { version: 1, state: { stage: 'inconclusive', defaultPrUrl: pr.url, pullRequest: pr, currentRunId: runId,
    originalRun: { id: runId, headRef: head, status: 'failed' }, fix: { requestedModel: 'gpt-6-astra', reportedModel: null },
    message: QUOTA_REJECTION_MESSAGE, error: QUOTA_REJECTION_MESSAGE, updatedAt: new Date().toISOString() }, intent: { kind: 'generate', headRef: head } };
  await writeFile(join(f.directory, 'review.json'), JSON.stringify(saved));
  const restored = createReviewManager(f.options); f.managers.push(restored);
  const state = await restored.status(); assert.equal(state.stage, 'failure_observed'); assert.equal(state.error, QUOTA_REJECTION_MESSAGE);
  assert.deepEqual(f.calls, []); assert.equal(f.states.size, 0);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'review.json'), 'utf8')).intent, undefined);
  restored.shutdown();
  await writeFile(join(f.directory, 'review.json'), JSON.stringify({ ...saved, state: { ...saved.state,
    fix: { ...saved.state.fix, generatedAt: new Date().toISOString(), summary: 'A patch was produced' } } }));
  const uncertain = createReviewManager(f.options); f.managers.push(uncertain);
  assert.equal((await uncertain.status()).stage, 'inconclusive');
  assert.equal(JSON.parse(await readFile(join(f.directory, 'review.json'), 'utf8')).intent.kind, 'generate');
});
