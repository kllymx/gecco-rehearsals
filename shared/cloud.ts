import type { Variant } from './contracts.js';

export type CloudSide = 'left' | 'right';
export type CloudAction = 'play' | 'pause' | 'read-both' | 'check-item' | 'deploy' | 'write-new' | 'rollback';
export interface CloudRevision {
  baseRef: string;
  headRef: string;
  pullRequest: { url: string; number: number; title: string; baseRef: string; headRef: string; headBranch: string };
}
export interface CloudObservation {
  outcome: 'passed' | 'failed' | 'inconclusive';
  at?: string;
  userId?: string;
  note?: string;
  sessionId?: string;
  error?: string;
  [key: string]: unknown;
}
export interface CloudApp {
  side: CloudSide;
  sandboxId?: string;
  state: string;
  release: string;
  entrypoint: string;
  sourceRef: string;
  previewUrl?: string;
  previewExpiresAt?: string;
  instanceId?: string;
  postgresVersion?: string;
  databaseId?: string;
  databaseKind?: string;
  observation?: CloudObservation;
}
export interface CloudEvent {
  id: string;
  at: string;
  title: string;
  detail: string;
  outcome?: 'passed' | 'failed' | 'inconclusive';
  evidence?: unknown;
}
export interface CloudSnapshot {
  id: string;
  provider: 'daytona';
  status: 'provisioning' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'closing' | 'closed';
  variant: Variant;
  label: string;
  phase: 'baseline' | 'rollout' | 'rollback';
  createdAt: string;
  expiresAt: string;
  revision: number;
  progress: { stage: string; detail: string };
  repository: string;
  change?: { title: string; baseRef: string; proposedRef: string };
  pullRequest?: CloudRevision['pullRequest'];
  apps: Record<CloudSide, CloudApp>;
  events: CloudEvent[];
  automation: { step: number; total: number; action?: string };
  busy: boolean;
  error?: string;
  cleanup?: unknown;
}
export interface CloudStatus {
  configured: boolean;
  activeId?: string;
  repository: string;
  sourceRef: string;
  reason?: string;
}
