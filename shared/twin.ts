import type { Outcome, Variant } from './contracts.js';
export type TwinSide = 'left' | 'right';
export type TwinPhase = 'baseline' | 'rollout' | 'rollback';
export type TwinAction = 'read-both' | 'read-left' | 'read-right' | 'save-left' | 'save-right' | 'deploy' | 'write-new' | 'rollback';
export interface TwinCreateInput { variant: Variant; label: string }
export interface TwinCommand { commandId: string; expectedRevision: number; action: TwinAction; note?: string }
export interface TwinObservation {
  outcome: Outcome; at: string; revision: number; userId?: string; role?: string; note?: string;
  sessionId: string; writeMarker?: string; error?: string;
}
export interface TwinAppState {
  instanceId: string; release: 'v1' | 'v2'; databaseId: string; sessionId: string;
  observation?: TwinObservation; stale: boolean;
}
export interface TwinEvent {
  id: string; action: 'create' | TwinAction; phase: TwinPhase; at: string; title: string;
  explanation: string; outcome: Outcome; durationMs: number;
  observations: Partial<Record<TwinSide, TwinObservation>>;
  sql: { databaseId: string; query: string; parameters?: unknown[]; rows?: Record<string, unknown>[]; error?: string }[];
}
export interface TwinDatabase {
  id: string; columns: string[]; rows: Record<string, unknown>[]; note: string;
}
export interface TwinSnapshot {
  id: string; revision: number; variant: Variant; label: string; phase: TwinPhase;
  createdAt: string; updatedAt: string; sourceDigest: string; fixtureDigest: string;
  apps: Record<TwinSide, TwinAppState>; databases: TwinDatabase[]; events: TwinEvent[];
  allowedActions: TwinAction[]; scope: string; busy: boolean;
  automation: { status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped'; stepIndex: number; totalSteps: number; currentAction?: TwinAction };
}
export const TWIN_JOURNEY: readonly TwinAction[] = ['read-both', 'deploy', 'read-both', 'write-new', 'read-right', 'read-left', 'rollback', 'read-both'];
