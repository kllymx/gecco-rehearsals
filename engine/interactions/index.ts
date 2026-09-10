import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Variant } from '../../shared/contracts.js';
import type { InteractionCell, InteractionCellId, InteractionObservation, InteractionRun, InteractionSpecimen } from '../../shared/interactions.js';
import { quoteCents as baseQuote } from './specimen/quote-base.js';
import { quoteCents as preciseQuote } from './specimen/quote-pr-a.js';
import { chargeCents as baseCharge } from './specimen/charge-base.js';
import { chargeCents as trustingCharge } from './specimen/charge-pr-b.js';
import { chargeCents as fixedCharge } from './specimen/charge-fixed.js';

const sourceDirectory = new URL('./specimen/', import.meta.url);
const readSource = (path: string) => readFileSync(new URL(path, sourceDirectory), 'utf8');
const sources = Object.fromEntries([
  'quote-base.ts', 'quote-pr-a.ts', 'charge-base.ts', 'charge-pr-b.ts', 'charge-fixed.ts',
].map(path => [path, readSource(path)]));
const fixtureSource = readSource('inputs.json');
type Input = InteractionObservation['input'];
const inputs = JSON.parse(fixtureSource) as Input[];

export const INTERACTION_CONTRACT = 'For every supplied non-negative integer subtotal and whole-number discount from 0 to 100 percent, the charge must be a safe integer number of cents equal to the exact discounted total rounded to the nearest cent, with half cents rounded up. The same contract and input corpus apply to the base, PR A alone, PR B alone, and both changes together.';
export const INTERACTION_SCOPE = 'Trusted local TypeScript functions composed across a fixed synthetic parallel-PR specimen. Quoted and charged amounts come from executing the bundled functions; expected cents use an independent exact-arithmetic oracle. No payment requests or PostgreSQL execution occur in this experiment. It does not import arbitrary pull requests, merge Git branches, or establish production safety.';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}
function assertVariant(variant: unknown): asserts variant is Variant {
  if (variant !== 'breaking' && variant !== 'compatible') throw new TypeError('variant must be "breaking" or "compatible"');
}

function validateInput(input: Input): void {
  if (!Number.isSafeInteger(input.subtotalCents) || input.subtotalCents < 0
    || !Number.isInteger(input.discountPercent) || input.discountPercent < 0 || input.discountPercent > 100) {
    throw new Error('The bundled fixture is outside the declared integer-cents contract.');
  }
}
for (const input of inputs) { validateInput(input); Object.freeze(input); }
Object.freeze(inputs);

// An independent exact-arithmetic oracle avoids repeating floating-point quote logic.
// For non-negative n / 100, adding 50 before integer division implements half-up rounding.
export function expectedChargeCents(input: Input): number {
  validateInput(input);
  return Number((BigInt(input.subtotalCents) * BigInt(100 - input.discountPercent) + 50n) / 100n);
}

export function getInteractionInputDigests(variant: Variant) {
  assertVariant(variant);
  const changedChargePath = variant === 'compatible' ? 'charge-fixed.ts' : 'charge-pr-b.ts';
  return {
    sourceDigest: hash({ contract: INTERACTION_CONTRACT, files: {
      'quote-base.ts': sources['quote-base.ts'], 'quote-pr-a.ts': sources['quote-pr-a.ts'],
      'charge-base.ts': sources['charge-base.ts'], [changedChargePath]: sources[changedChargePath],
    } }),
    fixtureDigest: hash({ 'inputs.json': fixtureSource }),
  };
}

export function getInteractionSpecimen(): InteractionSpecimen {
  return {
    title: 'Two green pull requests. One broken payment contract.',
    contract: INTERACTION_CONTRACT,
    changes: [
      { id: 'a', title: 'PR A · Preserve quote precision', path: 'quote.ts',
        rationale: 'Keep fractional cents in a quote so downstream calculations can retain precision.',
        before: sources['quote-base.ts'], after: sources['quote-pr-a.ts'] },
      { id: 'b', title: 'PR B · Simplify the payment boundary', path: 'charge.ts',
        rationale: 'Remove rounding at the charge boundary because the current quote function already returns integer cents.',
        before: sources['charge-base.ts'], after: sources['charge-pr-b.ts'] },
    ],
    fix: { path: 'charge.ts', code: sources['charge-fixed.ts'],
      explanation: 'Keep fractional precision in PR A while enforcing the integer-cents contract at the charge boundary in PR B.' },
    inputDigests: { breaking: getInteractionInputDigests('breaking'), compatible: getInteractionInputDigests('compatible') },
  };
}

function checkObservation(input: Input, quote: typeof baseQuote, charge: typeof baseCharge): InteractionObservation {
  const quotedCents = quote(input.subtotalCents, input.discountPercent);
  const chargedCents = charge(quotedCents);
  const expectedCents = expectedChargeCents(input);
  if (!Number.isFinite(quotedCents) || !Number.isFinite(chargedCents)) {
    // There is no honest JSON number to record; abort without fabricating an observation.
    throw new Error('Bundled execution produced a non-finite number; no complete interaction verdict was recorded.');
  }
  const problems: string[] = [];
  if (!Number.isSafeInteger(chargedCents)) problems.push(`the charged amount ${chargedCents} is not an integer number of cents`);
  if (chargedCents !== expectedCents) problems.push(`the charge ${chargedCents} differs from the exact rounded total ${expectedCents}`);
  return {
    input: { ...input }, quotedCents, chargedCents, expectedCents,
    outcome: problems.length ? 'failed' : 'passed',
    explanation: problems.length
      ? `Quote ${quotedCents}¢ → charge ${chargedCents}¢: ${problems.join('; ')}.`
      : `Quote ${quotedCents}¢ → charge ${chargedCents}¢. The charge is a safe integer and equals the exact rounded total ${expectedCents}¢.`,
  };
}

export async function runInteractions(variant: Variant): Promise<InteractionRun> {
  assertVariant(variant);
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const changedCharge = variant === 'compatible' ? fixedCharge : trustingCharge;
  const configurations: { id: InteractionCellId; title: string; activeChanges: string[]; quote: typeof baseQuote; charge: typeof baseCharge }[] = [
    { id: 'base', title: 'Base', activeChanges: [], quote: baseQuote, charge: baseCharge },
    { id: 'a', title: 'PR A alone', activeChanges: ['PR A'], quote: preciseQuote, charge: baseCharge },
    { id: 'b', title: 'PR B alone', activeChanges: ['PR B'], quote: baseQuote, charge: changedCharge },
    { id: 'combined', title: 'PR A + PR B', activeChanges: ['PR A', 'PR B'], quote: preciseQuote, charge: changedCharge },
  ];
  const cells: InteractionCell[] = configurations.map(configuration => {
    const cellStart = performance.now();
    const observations = inputs.map(input => checkObservation(input, configuration.quote, configuration.charge));
    return {
      id: configuration.id, title: configuration.title, activeChanges: configuration.activeChanges,
      outcome: observations.some(observation => observation.outcome === 'failed') ? 'failed' : 'passed',
      observations, durationMs: performance.now() - cellStart,
    };
  });
  const failed = cells.filter(cell => cell.outcome === 'failed').length;
  const failedObservations = cells.flatMap(cell => cell.observations).filter(observation => observation.outcome === 'failed').length;
  return {
    id: randomUUID(), variant, startedAt, completedAt: new Date().toISOString(),
    contract: INTERACTION_CONTRACT, ...getInteractionInputDigests(variant), cells,
    summary: `${cells.length - failed} configurations passed · ${failed} failed. ${inputs.length} shared inputs per configuration; ${failedObservations} observed contract violations across ${cells.length * inputs.length} executed attempts.`,
    scope: INTERACTION_SCOPE, durationMs: performance.now() - start,
  };
}
