import type { Session } from '../../engine/specimen/types.js';

export type ReleaseName = 'v1' | 'v2-breaking' | 'v2-compatible';
export type DatabaseTarget = { kind: 'local' } | { kind: 'gateway'; url: string; token: string; previewToken?: string; databaseId: string };
export interface Failure { name: string; message: string; code?: string; cause: string }
export interface Trace {
  sql: string; parameters: unknown[]; databaseId: string; at: string; durationMs: number;
  rows?: Record<string, unknown>[]; error?: Failure;
}
export interface Observation {
  outcome: 'passed' | 'failed' | 'inconclusive'; operation: 'read' | 'save';
  observedAt: string; release: ReleaseName; instanceId: string; databaseId: string;
  sessionId: string; userId?: string; role?: string; writeMarker?: string; note?: string;
  error?: Failure; trace: Trace[];
}
export interface Snapshot {
  schemaVersion: 1; revision: number; release: ReleaseName; instanceId: string; pid: number;
  startedAt: string; database: { id: string; kind: 'local' | 'gateway'; postgresVersion: string | null };
  selectedSessionId: string | null; autonomous: boolean; sourceDigest: string; fixtureDigest: string | null;
  observation: Observation | null;
}
export interface OperationResult { snapshot: Snapshot; trace: Trace[]; outcome: 'passed' | 'failed' | 'inconclusive'; error?: Failure }
export interface InitializeInput { label: string; sessionId: string; writeMarker: string; note: string }
export interface FieldnotesConfig {
  databaseId: string; target: DatabaseTarget; selectedSessionId: string | null; autonomous: boolean;
  fixtureDigest: string | null; initialized: boolean; revision: number;
  accepted: Record<string, { input: string; result: OperationResult }>;
}
export type { Session };
