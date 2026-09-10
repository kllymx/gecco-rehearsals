import type { CloudRevision } from './cloud.js';
export type { CloudRevision } from './cloud.js';

export type ReviewStage = 'waiting' | 'rehearsing' | 'failure_observed' | 'generating' | 'validating'
  | 'publishing' | 'rerunning' | 'verified' | 'failed' | 'inconclusive';

export type ReviewPullRequest = CloudRevision['pullRequest'];
export interface ReviewRun {
  id: string;
  headRef: string;
  status: 'running' | 'passed' | 'failed' | 'inconclusive';
  completedAt?: string;
}
export interface ReviewFix {
  requestedModel: 'gpt-6-astra';
  reportedModel: string | null;
  generatedAt?: string;
  summary?: string;
  files?: string[];
  commitSha?: string;
  commitUrl?: string;
  validation?: string;
}
export interface ReviewState {
  stage: ReviewStage;
  defaultPrUrl: string;
  id?: string;
  label?: string;
  pullRequest?: ReviewPullRequest;
  currentRunId?: string;
  originalRun?: ReviewRun;
  retestRun?: ReviewRun;
  fix?: ReviewFix;
  message: string;
  error?: string;
  startedAt?: string;
  updatedAt: string;
}
