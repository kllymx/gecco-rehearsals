import type { Outcome, Variant } from './contracts.js';

export type LabAction = 'read-old' | 'migrate' | 'write-new' | 'read-new' | 'rollback';
export type LabPhase = 'original' | 'upgraded' | 'rolled-back';
export interface LabCommand { commandId: string; expectedRevision: number; action: LabAction; }
export interface LabReadResult {
  release: 'v1' | 'v2';
  sessionId: string;
  outcome: Outcome;
  userId?: string;
  role?: string;
  writeMarker?: string;
  error?: string;
}
export interface LabEvent {
  id: string;
  action: 'create' | LabAction;
  at: string;
  outcome: Outcome;
  title: string;
  explanation: string;
  sql: { query: string; parameters?: unknown[]; rows?: Record<string, unknown>[]; error?: string }[];
  read?: LabReadResult;
  durationMs: number;
}
export interface LabSnapshot {
  id: string;
  revision: number;
  variant: Variant;
  phase: LabPhase;
  label: string;
  createdAt: string;
  updatedAt: string;
  databaseId: string;
  sourceDigest: string;
  fixtureDigest: string;
  columns: string[];
  rows: Record<string, unknown>[];
  selectedSessionId: string;
  newSessionId?: string;
  events: LabEvent[];
  allowedActions: LabAction[];
  scope: string;
}
export interface LabCreateInput { variant: Variant; label: string; }
