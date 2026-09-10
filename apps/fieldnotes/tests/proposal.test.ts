import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProposal, byteDigest } from '../proposal.js';
import { validateProposal } from '../validate-proposal.js';

const nativeAvailable = spawnSync('initdb', ['--version'], { encoding: 'utf8' }).status === 0;
async function candidate(variant: 'breaking' | 'compatible') {
  const root = await mkdtemp(join(tmpdir(), 'fieldnotes-candidate-'));
  await mkdir(join(root, 'apps/fieldnotes/deployment'), { recursive: true });
  await mkdir(join(root, 'engine/specimen'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // The repair stays on the same PR/release name. Only actual source and SQL change.
  await writeFile(join(root, 'apps/fieldnotes/release.json'), JSON.stringify({ release: 'v2-breaking' }));
  const original = await readFile(new URL(`../../../engine/specimen/v2-${variant}.ts`, import.meta.url), 'utf8');
  const release = original.replace("from './types.js'", "from '../../engine/specimen/types.js'")
    .replace('SELECT id,', 'SELECT /* proposed-reader-only */ id,')
    .replace('INSERT INTO sessions', 'INSERT /* proposed-writer-only */ INTO sessions');
  await writeFile(join(root, 'apps/fieldnotes/release.ts'), release);
  await writeFile(join(root, 'engine/specimen/types.ts'), await readFile(new URL('../../../engine/specimen/types.ts', import.meta.url), 'utf8'));
  for (const direction of ['up', 'down']) {
    const source = await readFile(new URL(`../../../engine/specimen/${variant}-${direction}.sql`, import.meta.url), 'utf8');
    await writeFile(join(root, `apps/fieldnotes/deployment/${direction}.sql`), `-- exact proposed ${variant} ${direction}\n${source}`);
  }
  return root;
}

for (const variant of ['breaking', 'compatible'] as const) test(`exact proposed ${variant} source, SQL and gateway determine the native contract`, { skip: !nativeAvailable, timeout: 60_000 }, async () => {
  const root = await candidate(variant);
  try {
    const proposed = await loadProposal(root);
    assert.equal(proposed.identity.release, 'v2-breaking');
    assert.equal(proposed.identity.releaseDigest, byteDigest(await readFile(join(root, 'apps/fieldnotes/release.ts'), 'utf8')));
    assert.deepEqual((await loadProposal(root)).identity, proposed.identity);
    const report = await validateProposal(root);
    assert.equal(report.outcome, variant === 'breaking' ? 'failed' : 'passed', report.error ?? JSON.stringify(report.checks));
    assert.equal(report.error, undefined);
    assert.deepEqual(report.proposal, proposed.identity);
    const operation = (name: string) => { const result = report.operations.find(entry => entry.name === name)?.result; assert(result, name); return result; };
    assert.equal(operation('baseline-left').outcome, 'passed');
    assert.equal(operation('baseline-right').outcome, 'passed');
    assert.equal(operation('mixed-left').outcome, variant === 'breaking' ? 'failed' : 'passed');
    assert.equal(operation('mixed-right').outcome, 'passed');
    assert.equal(operation('migrate-shared').trace.find(step => step.sql.includes('-- exact proposed'))?.sql, proposed.up);
    assert.equal(operation('rollback-schema').trace.find(step => step.sql.includes('-- exact proposed'))?.sql, proposed.down);
    assert(operation('mixed-right').trace.some(step => step.sql.includes('/* proposed-reader-only */') && step.rows?.length === 1), 'gateway executes the proposed query, not the same-name bundled reader');
    assert(operation('write-new').trace.some(step => step.sql.includes('/* proposed-writer-only */') && !step.error), 'gateway executes the exact proposed writer');
    assert.equal(operation('write-new').snapshot.proposal?.digest, proposed.identity.digest);
    assert.equal(operation('new-right').snapshot.selectedSessionId, operation('rollback-right').snapshot.selectedSessionId);
    if (variant === 'compatible') {
      assert(report.checks.every(check => check.passed));
      assert.equal(operation('new-right').snapshot.observation?.writeMarker, operation('rollback-right').snapshot.observation?.writeMarker);
    } else {
      assert.equal(operation('mixed-left').error?.code, '42703');
      assert.equal(operation('rollback-left').error?.name, 'SessionContractError');
    }
    assert(!JSON.stringify(report).includes(root), 'runtime paths are not part of public evidence');
  } finally { await rm(root, { recursive: true, force: true }); }
});
