export type Variant = 'breaking' | 'compatible';
export type ScenarioId = 'control' | 'upgrade' | 'mixed' | 'rollback';
export type Outcome = 'passed' | 'failed' | 'inconclusive';
export interface TraceStep {
  id: string;
  label: string;
  sql?: string;
  observation: string;
  outcome: Outcome;
  rows?: Record<string, unknown>[];
  durationMs: number;
}
export interface ScenarioResult {
  id: ScenarioId;
  title: string;
  description: string;
  expected: string;
  outcome: Outcome;
  explanation: string;
  steps: TraceStep[];
  fixtureId: string;
  stateFingerprint: string;
  markedWriteId?: string;
  durationMs: number;
}
export interface RehearsalRun {
  id: string;
  variant: Variant;
  startedAt: string;
  completedAt: string;
  engine: 'pglite-postgres';
  sourceDigest: string;
  fixtureDigest: string;
  contract: string;
  scenarios: ScenarioResult[];
  summary: string;
  durationMs: number;
  scope: string;
}
export interface Specimen {
  id: string;
  title: string;
  description: string;
  contract: string;
  currentRelease: string;
  proposedRelease: string;
  files: { path: string; before: string; breaking: string; compatible: string }[];
}
export interface AnalysisResult {
  status: 'completed' | 'unavailable' | 'failed';
  provider: string;
  model: string | null;
  generatedAt: string;
  summary: string;
  hypotheses: { scenarioId: ScenarioId; risk: string; rationale: string }[];
  suggestedFix: string;
  error?: string;
}
