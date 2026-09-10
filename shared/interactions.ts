import type { Outcome, Variant } from './contracts.js';

export type InteractionCellId = 'base' | 'a' | 'b' | 'combined';
export interface InteractionObservation {
  input: { subtotalCents: number; discountPercent: number };
  quotedCents: number;
  chargedCents: number;
  expectedCents: number;
  outcome: Outcome;
  explanation: string;
}
export interface InteractionCell {
  id: InteractionCellId;
  title: string;
  activeChanges: string[];
  outcome: Outcome;
  observations: InteractionObservation[];
  durationMs: number;
}
export interface InteractionRun {
  id: string;
  variant: Variant;
  startedAt: string;
  completedAt: string;
  contract: string;
  sourceDigest: string;
  fixtureDigest: string;
  cells: InteractionCell[];
  summary: string;
  scope: string;
  durationMs: number;
}
export interface InteractionSpecimen {
  title: string;
  contract: string;
  changes: { id: string; title: string; path: string; rationale: string; before: string; after: string }[];
  fix: { path: string; code: string; explanation: string };
  inputDigests: Record<Variant, { sourceDigest: string; fixtureDigest: string }>;
}
