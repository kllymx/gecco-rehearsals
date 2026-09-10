import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { CONTRACT, getInputDigests, getSpecimen, runRehearsal } from '../engine/index.js';
import type { RehearsalRun, ScenarioResult, Variant } from '../shared/contracts.js';

let broken: RehearsalRun;
let fixed: RehearsalRun;
let repeat: RehearsalRun;

before(async () => {
  broken = await runRehearsal('breaking');
  fixed = await runRehearsal('compatible');
  repeat = await runRehearsal('compatible');
});

const matrix = (run: RehearsalRun) => Object.fromEntries(run.scenarios.map(trial => [trial.id, trial.outcome]));
function stateSnapshots(trial: ScenarioResult) {
  return trial.steps.filter(step => step.rows?.[0] && 'sessions' in step.rows[0]).map(step => step.rows![0]);
}
function sessions(state: Record<string, unknown>): Record<string, unknown>[] {
  return state.sessions as Record<string, unknown>[];
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

test('real breaking proposal passes isolated releases and fails both transition contracts', () => {
  assert.deepEqual(matrix(broken), { control: 'passed', upgrade: 'passed', mixed: 'failed', rollback: 'failed' });
  const mixed = broken.scenarios.find(trial => trial.id === 'mixed')!;
  assert.ok(mixed.steps.some(step => step.outcome === 'failed' && step.observation.includes('PostgreSQL 42703')));
  const rollback = broken.scenarios.find(trial => trial.id === 'rollback')!;
  assert.ok(rollback.steps.some(step => step.outcome === 'failed' && step.observation.includes('v1 requires flat')));
  assert.equal(broken.engine, 'pglite-postgres');
});

test('compatible expand/contract passes the same declared contract, including old writers', () => {
  assert.equal(broken.contract, fixed.contract);
  assert.deepEqual(matrix(fixed), { control: 'passed', upgrade: 'passed', mixed: 'passed', rollback: 'passed' });
  const mixed = fixed.scenarios.find(trial => trial.id === 'mixed')!;
  assert.ok(mixed.steps.some(step => step.label === 'v2 reads a session written by the old process' && step.outcome === 'passed'));
});

test('rollback preserves and reads the exact marked v2 write in both variants', () => {
  for (const run of [broken, fixed]) {
    const rollback = run.scenarios.find(trial => trial.id === 'rollback')!;
    const snapshots = stateSnapshots(rollback);
    assert.equal(snapshots.length, 2, 'state must be captured before and after rollback');
    const beforeWrite = sessions(snapshots[0]).find(row => row.id === rollback.markedWriteId)!;
    const afterWrite = sessions(snapshots[1]).find(row => row.id === rollback.markedWriteId)!;
    assert.ok(beforeWrite);
    assert.ok(afterWrite);
    const beforePayload = beforeWrite.identity_payload as Record<string, unknown>;
    const afterPayload = afterWrite.session_payload as Record<string, unknown>;
    assert.match(String(beforePayload.writeMarker), /^written-by-v2-/);
    assert.equal(beforePayload.writeMarker, afterPayload.writeMarker);
    const rollbackRead = rollback.steps.find(step => step.label === 'Rolled-back v1 reads the exact marked v2 write · SQL')!;
    assert.equal(rollbackRead.rows?.[0]?.id, rollback.markedWriteId);
    assert.equal((rollbackRead.rows?.[0]?.session_payload as Record<string, unknown>).writeMarker, beforePayload.writeMarker);
    assert.equal(rollback.steps.filter(step => step.label === 'Load original fixture').length, 1);
    assert.notDeepEqual(snapshots[0], snapshots[1], 'rollback changes schema while retaining the marked write');
  }
});

test('repeated trials start from fresh fixtures and never retain another trial\'s writes', () => {
  const trials = [...broken.scenarios, ...fixed.scenarios, ...repeat.scenarios];
  assert.equal(new Set(trials.map(trial => trial.fixtureId)).size, trials.length);
  assert.equal(new Set(trials.map(trial => trial.markedWriteId)).size, trials.length);
  for (const trial of trials) {
    const final = stateSnapshots(trial).at(-1)!;
    const rows = sessions(final);
    assert.ok(rows.some(row => row.id === 'seed-session'));
    assert.ok(rows.some(row => row.id === trial.markedWriteId));
    const otherTrialIds = new Set(trials.filter(other => other !== trial).map(other => other.markedWriteId));
    assert.ok(rows.every(row => !otherTrialIds.has(String(row.id))));
    assert.equal(rows.length, trial.id === 'mixed' && trial.outcome === 'passed' ? 3 : 2);
    assert.equal(trial.steps.at(-1)?.label, 'Close disposable PostgreSQL');
    assert.equal(trial.steps.at(-1)?.outcome, 'passed');
  }
  assert.deepEqual(matrix(fixed), matrix(repeat));
});

test('source/fixture digests are deterministic and describe actual displayed and executed files', () => {
  const specimen = getSpecimen();
  const path = new URL('../engine/specimen/', import.meta.url);
  const source = (file: string) => readFileSync(new URL(file, path), 'utf8');
  const session = specimen.files.find(file => file.path === 'session.ts')!;
  assert.equal(session.before, source('v1.ts'));
  assert.equal(session.breaking, source('v2-breaking.ts'));
  assert.equal(session.compatible, source('v2-compatible.ts'));
  for (const run of [broken, fixed]) {
    const { variant } = run;
    assert.equal(run.sourceDigest, hash({ contract: CONTRACT, files: {
      'types.ts': source('types.ts'), 'v1.ts': source('v1.ts'),
      [`v2-${variant}.ts`]: source(`v2-${variant}.ts`),
      [`${variant}-up.sql`]: source(`${variant}-up.sql`),
      [`${variant}-down.sql`]: source(`${variant}-down.sql`),
    } }));
    assert.equal(run.fixtureDigest, hash({ 'fixture.sql': source('fixture.sql') }));
    const upgrade = run.scenarios.find(trial => trial.id === 'upgrade')!;
    assert.equal(upgrade.steps.find(step => step.label === 'Apply v2 migration')?.sql, source(`${variant}-up.sql`));
    assert.equal(specimen.files.find(file => file.path === 'migration.up.sql')?.[variant], source(`${variant}-up.sql`));
    assert.deepEqual(getInputDigests(variant), { sourceDigest: run.sourceDigest, fixtureDigest: run.fixtureDigest });
  }
  assert.equal(fixed.sourceDigest, repeat.sourceDigest);
  assert.equal(broken.fixtureDigest, fixed.fixtureDigest);
  assert.notEqual(broken.sourceDigest, fixed.sourceDigest);
  assert.notEqual(fixed.id, repeat.id);
});

test('every fingerprint is independently reproducible from complete recorded logical state', () => {
  for (const run of [broken, fixed]) for (const trial of run.scenarios) {
    assert.equal(trial.stateFingerprint, hash(stateSnapshots(trial).at(-1)));
    const provenance = trial.steps.find(step => step.sql === 'SELECT version() AS postgres_version');
    assert.match(String(provenance?.rows?.[0]?.postgres_version), /PostgreSQL/);
    assert.ok(trial.steps.every(step => Number.isFinite(step.durationMs) && step.durationMs >= 0));
  }
});

test('rejects invalid variants before allocating a database', async context => {
  const query = context.mock.method(PGlite.prototype, 'exec');
  for (const variant of ['other', undefined, null, {}, 1]) {
    await assert.rejects(runRehearsal(variant as Variant), /variant must be/);
    assert.throws(() => getInputDigests(variant as Variant), /variant must be/);
  }
  assert.equal(query.mock.callCount(), 0);
});

test('failed fixture setup is inconclusive and all allocated databases close', async context => {
  context.mock.method(PGlite.prototype, 'exec', async () => { throw new Error('simulated fixture loading failure'); });
  const close = context.mock.method(PGlite.prototype, 'close');
  const run = await runRehearsal('breaking');
  assert.ok(run.scenarios.every(trial => trial.outcome === 'inconclusive'));
  assert.ok(run.scenarios.every(trial => trial.steps.some(step => step.label === 'Load original fixture' && step.outcome === 'inconclusive')));
  // PGlite also closes an internal bootstrap database for every fixture.
  const databases = new Set(close.mock.calls.map(call => call.this as PGlite));
  assert.ok(databases.size >= 4);
  assert.ok([...databases].every(db => db.closed));
  assert.ok(run.scenarios.every(trial => trial.steps.at(-1)?.outcome === 'passed'));
});

test('a migration that cannot establish the test state is inconclusive, not a compatibility verdict', async context => {
  const execute = PGlite.prototype.exec;
  context.mock.method(PGlite.prototype, 'exec', async function (this: PGlite, sql: string) {
    if (sql.includes('ALTER TABLE')) throw Object.assign(new Error('simulated migration missing column'), { code: '42703' });
    return execute.call(this, sql);
  });
  const close = context.mock.method(PGlite.prototype, 'close');
  const run = await runRehearsal('compatible');
  assert.deepEqual(matrix(run), { control: 'passed', upgrade: 'inconclusive', mixed: 'inconclusive', rollback: 'inconclusive' });
  for (const trial of run.scenarios.filter(trial => trial.id !== 'control')) {
    assert.ok(!trial.steps.some(step => step.label === 'v2 reads migrated session'));
    assert.equal(trial.steps.find(step => step.label === 'Apply v2 migration')?.outcome, 'inconclusive');
  }
  const databases = new Set(close.mock.calls.map(call => call.this as PGlite));
  assert.ok(databases.size >= 4);
  assert.ok([...databases].every(db => db.closed));
});
