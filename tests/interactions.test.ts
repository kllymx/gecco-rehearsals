import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { expectedChargeCents, getInteractionInputDigests, getInteractionSpecimen, INTERACTION_CONTRACT, runInteractions } from '../engine/interactions/index.js';
import type { Variant } from '../shared/contracts.js';
import type { InteractionRun } from '../shared/interactions.js';

const broken = await runInteractions('breaking');
const fixed = await runInteractions('compatible');
const matrix = (run: InteractionRun) => Object.fromEntries(run.cells.map(cell => [cell.id, cell.outcome]));

test('each parallel PR passes alone, while the combined actual outputs violate integer cents', () => {
  assert.deepEqual(matrix(broken), { base: 'passed', a: 'passed', b: 'passed', combined: 'failed' });
  const fractional = broken.cells.find(cell => cell.id === 'combined')!.observations[0];
  assert.deepEqual(fractional.input, { subtotalCents: 999, discountPercent: 5 });
  assert.equal(fractional.quotedCents, 949.05);
  assert.equal(fractional.chargedCents, 949.05);
  assert.equal(fractional.expectedCents, 949);
  assert.equal(fractional.outcome, 'failed');
  assert.match(fractional.explanation, /not an integer/);
  assert.match(fractional.explanation, /differs from the exact rounded total/);
  const preciseAlone = broken.cells.find(cell => cell.id === 'a')!.observations[0];
  assert.equal(preciseAlone.quotedCents, 949.05);
  assert.equal(preciseAlone.chargedCents, 949);
  const trustingAlone = broken.cells.find(cell => cell.id === 'b')!.observations[0];
  assert.equal(trustingAlone.quotedCents, 949);
  assert.equal(trustingAlone.chargedCents, 949);
});

test('restoring payment-boundary rounding preserves quote precision and passes every configuration', () => {
  assert.deepEqual(matrix(fixed), { base: 'passed', a: 'passed', b: 'passed', combined: 'passed' });
  const combined = fixed.cells.find(cell => cell.id === 'combined')!;
  assert.equal(combined.observations[0].quotedCents, 949.05);
  assert.equal(combined.observations[0].chargedCents, 949);
  assert.ok(fixed.cells.flatMap(cell => cell.observations).every(attempt => Number.isSafeInteger(attempt.chargedCents) && attempt.chargedCents === attempt.expectedCents));
});

test('all cells and both variants execute the identical contract and input corpus, retaining controls and failures', () => {
  assert.equal(broken.contract, fixed.contract);
  const reference = broken.cells[0].observations.map(observation => observation.input);
  for (const run of [broken, fixed]) for (const cell of run.cells) {
    assert.equal(cell.observations.length, 6);
    assert.deepEqual(cell.observations.map(observation => observation.input), reference);
    assert.deepEqual(cell.observations.slice(2).map(observation => observation.chargedCents), [950, 2000, 1499, 0]);
    assert.ok(cell.observations.slice(2).every(observation => observation.outcome === 'passed'));
  }
  const combined = broken.cells.find(cell => cell.id === 'combined')!;
  assert.deepEqual(combined.observations.map(observation => observation.outcome), ['failed', 'failed', 'passed', 'passed', 'passed', 'passed']);
  assert.equal(combined.observations[1].quotedCents, 50.5);
  assert.equal(combined.observations[1].expectedCents, 51);
  assert.equal(broken.fixtureDigest, fixed.fixtureDigest);
});

test('the independent exact arithmetic oracle implements half-up cents and validates fixture bounds', () => {
  assert.equal(expectedChargeCents({ subtotalCents: 999, discountPercent: 5 }), 949);
  assert.equal(expectedChargeCents({ subtotalCents: 101, discountPercent: 50 }), 51);
  assert.equal(expectedChargeCents({ subtotalCents: 99, discountPercent: 50 }), 50);
  assert.equal(expectedChargeCents({ subtotalCents: Number.MAX_SAFE_INTEGER, discountPercent: 0 }), Number.MAX_SAFE_INTEGER);
  assert.throws(() => expectedChargeCents({ subtotalCents: -1, discountPercent: 5 }), /fixture/);
  assert.throws(() => expectedChargeCents({ subtotalCents: 1, discountPercent: 101 }), /fixture/);
});

test('source display and deterministic digests identify the actual executed functions and corpus', async () => {
  const specimen = getInteractionSpecimen();
  const source = (path: string) => readFileSync(new URL(`../engine/interactions/specimen/${path}`, import.meta.url), 'utf8');
  assert.equal(specimen.changes[0].before, source('quote-base.ts'));
  assert.equal(specimen.changes[0].after, source('quote-pr-a.ts'));
  assert.equal(specimen.changes[1].before, source('charge-base.ts'));
  assert.equal(specimen.changes[1].after, source('charge-pr-b.ts'));
  assert.equal(specimen.fix.code, source('charge-fixed.ts'));
  function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
  for (const run of [broken, fixed]) {
    const chargePath = run.variant === 'compatible' ? 'charge-fixed.ts' : 'charge-pr-b.ts';
    assert.equal(run.sourceDigest, hash({ contract: INTERACTION_CONTRACT, files: {
      'quote-base.ts': source('quote-base.ts'), 'quote-pr-a.ts': source('quote-pr-a.ts'),
      'charge-base.ts': source('charge-base.ts'), [chargePath]: source(chargePath),
    } }));
    assert.equal(run.fixtureDigest, hash({ 'inputs.json': source('inputs.json') }));
    assert.deepEqual(specimen.inputDigests[run.variant], getInteractionInputDigests(run.variant));
  }
  const repeat = await runInteractions('breaking');
  assert.equal(repeat.sourceDigest, broken.sourceDigest);
  assert.equal(repeat.fixtureDigest, broken.fixtureDigest);
  assert.notEqual(fixed.sourceDigest, broken.sourceDigest);
  assert.notEqual(repeat.id, broken.id);
  assert.deepEqual(repeat.cells.map(cell => cell.observations), broken.cells.map(cell => cell.observations));
  assert.match(repeat.scope, /No payment requests or PostgreSQL execution/);
});

test('invalid variants cannot select unintended functions', async () => {
  for (const variant of ['other', undefined, null, 1]) {
    await assert.rejects(runInteractions(variant as Variant), /variant must be/);
    assert.throws(() => getInteractionInputDigests(variant as Variant), /variant must be/);
  }
});
