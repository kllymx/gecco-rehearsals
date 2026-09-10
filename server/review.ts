import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { CloudSnapshot } from '../shared/cloud.js';
import type { ReviewPullRequest, ReviewRun, ReviewState } from '../shared/review.js';
import type { CloudManager } from './cloud.js';
import { createRepairBackend, parsePrUrl, repairFailure, REPAIR_MODEL, ReviewError, type RepairBackend } from './repair.js';
export { ReviewError as ReviewApiError } from './repair.js';

export interface ReviewManager {
  status(): Promise<ReviewState>;
  start(input: unknown): Promise<ReviewState>;
  fix(): Promise<ReviewState>;
  shutdown(): void;
}
export interface ReviewOptions {
  cwd: string;
  stateDirectory: string;
  cloud: CloudManager;
  defaultPrUrl: string;
  backend?: RepairBackend;
  pollMs?: number;
  cleanupTimeoutMs?: number;
}
type Intent = { kind: 'create-original' | 'generate' | 'validate' | 'push' | 'cleanup' | 'create-retest';
  headRef: string; commitSha?: string; oldRunId?: string };
interface Saved { version: 1; state: ReviewState; intent?: Intent }
const iso = () => new Date().toISOString();
const terminalCloud = new Set(['completed', 'failed', 'closed']);
const pipeline = new Set(['generating', 'validating', 'publishing', 'rerunning']);
function sameRevision(pr: ReviewPullRequest, other: ReviewPullRequest) {
  return pr.url === other.url && pr.baseRef === other.baseRef && pr.headRef === other.headRef && pr.headBranch === other.headBranch;
}
/** Only completed observations count. No inference output can set a database verdict. */
export function reviewOutcome(snapshot: CloudSnapshot): ReviewRun['status'] {
  if (snapshot.status === 'completed' && snapshot.busy) return 'running';
  if (!terminalCloud.has(snapshot.status)) return 'running';
  if (snapshot.status !== 'completed' || snapshot.phase !== 'rollout' || snapshot.busy
    || snapshot.automation.total !== 7 || snapshot.automation.step !== 7) return 'inconclusive';
  if (snapshot.events.some(event => event.outcome === 'inconclusive')) return 'inconclusive';
  const paired = snapshot.events.filter(event => event.title === 'Old and new code tested against release data');
  const last = paired.at(-1)?.evidence as { left?: { outcome?: string }; right?: { outcome?: string } } | undefined;
  // Read the completed event receipts, never mutable observations refreshed by browser traffic.
  if (paired.length !== 2 || !last?.left?.outcome || !last?.right?.outcome) return 'inconclusive';
  if (snapshot.events.some(event => event.outcome === 'failed') || last.left.outcome === 'failed' || last.right.outcome === 'failed') return 'failed';
  const required = ['Both versions tested independently', 'The new launch board works on its own',
    'Release deployed into the shared database', 'The new app created a real session', 'The new launch board saved into the release database'];
  return last.left.outcome === 'passed' && last.right.outcome === 'passed' && paired.every(event => event.outcome === 'passed')
    && required.every(title => snapshot.events.some(event => event.title === title && event.outcome === 'passed')) ? 'passed' : 'inconclusive';
}
function safeText(value: unknown, maximum = 2000): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/https?:\/\/\S+/g, '[URL removed]').replace(/Bearer\s+\S+/gi, '[credential removed]')
    .replace(/\b(?:token|secret|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '[credential removed]').slice(0, maximum);
}
/** Deliberately excludes notes, tokens, sandbox URLs, arbitrary nested evidence, and admin paths. */
export function failureEvidence(snapshot: CloudSnapshot): unknown[] {
  const failures: unknown[] = [];
  for (const side of ['left', 'right'] as const) {
    const observation = snapshot.apps[side].observation;
    if (observation?.outcome === 'failed') failures.push({ side, release: snapshot.apps[side].release,
      outcome: observation.outcome, error: safeText(observation.error), observedAt: safeText(observation.at, 100) });
  }
  for (const event of snapshot.events) {
    if (event.outcome !== 'failed') continue;
    const evidence = event.evidence as { error?: unknown; left?: { error?: unknown }; right?: { error?: unknown } } | undefined;
    const errorText = (value: unknown) => typeof value === 'string' ? safeText(value)
      : value && typeof value === 'object' ? safeText((value as { message?: unknown }).message) : undefined;
    failures.push({ outcome: 'failed', title: safeText(event.title, 300), detail: safeText(event.detail), at: event.at,
      error: errorText(evidence?.error), leftError: errorText(evidence?.left?.error), rightError: errorText(evidence?.right?.error) });
  }
  return failures.slice(-20);
}
export function createReviewManager(options: ReviewOptions): ReviewManager {
  parsePrUrl(options.defaultPrUrl);
  const backend = options.backend ?? createRepairBackend(options);
  const path = join(options.stateDirectory, 'review.json');
  let saved: Saved = { version: 1, state: { stage: 'waiting', defaultPrUrl: options.defaultPrUrl,
    message: 'Choose the public pull request to rehearse its exact code.', updatedAt: iso() } };
  let stopped = false;
  let reserved = false;
  let job: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  const present = () => structuredClone(saved.state);
  async function persist() {
    const bytes = JSON.stringify(saved);
    const action = writes.then(async () => {
      await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(options.stateDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    });
    writes = action.catch(() => { /* The failing caller still receives the error. */ });
    await action;
  }
  async function stage(value: ReviewState['stage'], message: string, intent?: Intent) {
    saved.state.stage = value; saved.state.message = message; saved.state.updatedAt = iso(); saved.intent = intent;
    delete saved.state.error;
    await persist();
  }
  function checkRunning() { if (stopped || abort.signal.aborted) throw new ReviewError(503, 'The review coordinator is shutting down.'); }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (stopped || !['rehearsing', 'rerunning'].includes(saved.state.stage)) return;
    timer = setTimeout(() => { void refresh().catch(() => { /* status retains the last confirmed state. */ }); }, options.pollMs ?? 2000);
    timer.unref();
  }
  async function cloudMatches(id: string, headRef: string) {
    const snapshot = await options.cloud.snapshot(id);
    const pr = saved.state.pullRequest!;
    if (snapshot.change?.baseRef !== pr.baseRef || snapshot.change.proposedRef !== headRef
      || snapshot.pullRequest?.url !== pr.url) throw new ReviewError(409, 'The sandbox source does not match the saved pull request revision.');
    return snapshot;
  }
  async function markInconclusive(message: string) {
    saved.state.stage = 'inconclusive'; saved.state.message = message; saved.state.error = message; saved.state.updatedAt = iso();
    await persist();
  }
  async function refresh() {
    if (refreshing) return refreshing;
    if (job || stopped || !saved.state.currentRunId || !['rehearsing', 'rerunning'].includes(saved.state.stage)) return;
    refreshing = (async () => {
      const isRetest = saved.state.stage === 'rerunning';
      const run = isRetest ? saved.state.retestRun : saved.state.originalRun;
      if (!run) return;
      const snapshot = await cloudMatches(run.id, run.headRef);
      const outcome = reviewOutcome(snapshot);
      if (outcome === 'running') return;
      run.status = outcome; run.completedAt = iso();
      if (outcome === 'passed') await stage('verified', isRetest
        ? 'The Astra commit passed the same seven rollout checks in a fresh Daytona pair.'
        : 'This exact PR passed the seven rollout checks. No repair was needed.');
      else if (outcome === 'failed') await stage(isRetest ? 'failed' : 'failure_observed', isRetest
        ? 'The generated commit still failed an actual rollout check. Its results and commit remain available.'
        : 'The exact PR completed its rehearsal with a real compatibility failure. Astra can now propose and publish a tested repair.');
      else await markInconclusive('The cloud rehearsal did not establish a complete rollout result. No pass or repair eligibility was inferred.');
    })().catch(async error => { await markInconclusive(repairFailure(error)); })
      .finally(() => { refreshing = undefined; schedule(); });
    return refreshing;
  }
  async function reconcileCreate(kind: 'create-original' | 'create-retest', headRef: string): Promise<boolean> {
    const status = await options.cloud.status();
    if (!status.activeId) return false;
    const snapshot = await cloudMatches(status.activeId, headRef);
    const run: ReviewRun = { id: snapshot.id, headRef, status: 'running' };
    saved.state.currentRunId = snapshot.id;
    if (kind === 'create-original') saved.state.originalRun = run; else saved.state.retestRun = run;
    saved.intent = undefined;
    await stage(kind === 'create-original' ? 'rehearsing' : 'rerunning', 'The saved creation intent was reconciled to the exact running sandbox pair.');
    return true;
  }
  const ready = (async () => {
    try {
      const bytes = await readFile(path, 'utf8');
      if (bytes.length > 100_000) throw new Error('state limit');
      const previous = JSON.parse(bytes) as Saved;
      if (previous.version !== 1 || !previous.state || typeof previous.state.stage !== 'string') throw new Error('state shape');
      saved = previous; saved.state.defaultPrUrl = options.defaultPrUrl;
      if (saved.intent?.kind === 'push' && saved.state.pullRequest && saved.intent.commitSha) {
        const current = await backend.remoteHead(saved.state.pullRequest, abort.signal);
        if (current === saved.intent.commitSha) {
          saved.state.fix!.commitSha = current; saved.state.fix!.commitUrl = `https://github.com/kllymx/gecco-rehearsals/commit/${current}`;
          await markInconclusive('The published fix commit was confirmed after restart. The interrupted cleanup/rerun was not replayed automatically.');
        } else await markInconclusive('Publishing was interrupted. The remote branch was inspected, and no push or inference was retried.');
      } else if (saved.intent?.kind === 'create-original' || saved.intent?.kind === 'create-retest') {
        if (!await reconcileCreate(saved.intent.kind, saved.intent.headRef)) await markInconclusive('An interrupted sandbox creation could not be reconciled. No replacement pair was allocated.');
      } else if (pipeline.has(saved.state.stage) && saved.state.stage !== 'rerunning') {
        await markInconclusive('The repair was interrupted by coordinator restart. No model call, publication, or sandbox allocation was replayed.');
      } else if (saved.intent) await markInconclusive('An interrupted operation requires reconciliation. No automatic replay was attempted.');
      else if (saved.state.stage === 'rehearsing' && !saved.state.currentRunId)
        await markInconclusive('PR resolution was interrupted before sandbox creation. No allocation was replayed.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        saved.state.stage = 'inconclusive'; saved.state.message = 'The saved review could not be safely recovered. Existing operations were not replayed.';
        saved.state.error = saved.state.message;
      }
    }
    schedule();
  })();
  function launch(operation: () => Promise<void>) {
    job = operation().catch(async error => {
      const intent = saved.intent;
      if (intent?.kind === 'create-original' || intent?.kind === 'create-retest') {
        try { if (await reconcileCreate(intent.kind, intent.headRef)) return; } catch { /* Preserve unknown intent. */ }
      }
      await markInconclusive(repairFailure(error));
    }).finally(() => { job = undefined; reserved = false; schedule(); });
    // The caller receives the durable accepted state, not a request-coupled long job.
    void job.catch(() => { reserved = false; });
  }
  async function createRun(headRef: string, retest: boolean) {
    checkRunning();
    const pr = saved.state.pullRequest!;
    const current = await backend.resolvePr(pr.url, abort.signal);
    if (current.baseRef !== pr.baseRef || current.headRef !== headRef || current.headBranch !== pr.headBranch)
      throw new ReviewError(409, 'The PR changed before sandbox creation. Start a new review of its current revision.');
    if ((await options.cloud.status()).activeId) throw new ReviewError(409, 'Another cloud pair is active. No new pair was allocated.');
    const kind = retest ? 'create-retest' : 'create-original';
    await stage(retest ? 'rerunning' : 'rehearsing', retest ? 'Creating a fresh pair at the published Astra commit.' : 'Creating two real sandboxes at the exact PR revision.', { kind, headRef });
    checkRunning();
    const snapshot = await options.cloud.create({ variant: 'breaking', label: saved.state.label }, {
      baseRef: pr.baseRef, headRef, pullRequest: { ...pr, headRef } });
    saved.state.currentRunId = snapshot.id;
    const run: ReviewRun = { id: snapshot.id, headRef, status: 'running' };
    if (retest) saved.state.retestRun = run; else saved.state.originalRun = run;
    await stage(retest ? 'rerunning' : 'rehearsing', 'The exact source is being installed and rehearsed in two Daytona sandboxes.');
    // CloudManager starts its own journey after provisioning. No request-coupled play or replay is needed.
  }
  async function waitForDeletion(id: string) {
    const deadline = Date.now() + (options.cleanupTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      checkRunning();
      const state = await options.cloud.snapshot(id);
      if (state.status === 'closed' && (state.cleanup as { complete?: boolean } | undefined)?.complete === true) return;
      if (state.status === 'failed') throw new ReviewError(502, 'Deletion of the old sandboxes could not be confirmed. No replacement was created.');
      await new Promise<void>((resolve, reject) => {
        const finished = () => { abort.signal.removeEventListener('abort', cancelled); resolve(); };
        const timeout = setTimeout(finished, Math.min(options.pollMs ?? 1000, 1000));
        const cancelled = () => { clearTimeout(timeout); reject(new ReviewError(503, 'Cleanup waiting was interrupted.')); };
        abort.signal.addEventListener('abort', cancelled, { once: true });
      });
    }
    throw new ReviewError(504, 'The old sandbox deletion deadline expired. No replacement pair was created.');
  }
  return {
    async status() { await ready; await refresh(); return present(); },
    async start(input) {
      await ready; checkRunning();
      const body = input as { prUrl?: unknown; label?: unknown };
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['prUrl', 'label'].includes(key))) throw new ReviewError(400, 'Provide only prUrl and label.');
      parsePrUrl(body.prUrl);
      if (typeof body.label !== 'string' || !body.label.trim() || [...body.label.trim()].length > 48 || /[\x00-\x1f\x7f-\x9f]/.test(body.label))
        throw new ReviewError(400, 'Use a label of 1–48 characters without control characters.');
      if (reserved || job || ['rehearsing', 'rerunning'].includes(saved.state.stage)) throw new ReviewError(409, 'A review operation is already active.');
      if (saved.intent) throw new ReviewError(409, 'A saved uncertain operation must be reconciled before starting another review.');
      reserved = true;
      try {
        if ((await options.cloud.status()).activeId) throw new ReviewError(409, 'Close the active sandbox pair before starting a PR rehearsal.');
        saved = { version: 1, state: { stage: 'rehearsing', id: randomUUID(), label: body.label.trim(), defaultPrUrl: options.defaultPrUrl,
          message: 'Resolving the open public pull request and its exact base/head commits.', startedAt: iso(), updatedAt: iso() } };
        await persist();
        const url = body.prUrl as string;
        launch(async () => {
          saved.state.pullRequest = await backend.resolvePr(url, abort.signal);
          await persist();
          await createRun(saved.state.pullRequest.headRef, false);
        });
        return present();
      } catch (error) { reserved = false; throw error; }
    },
    async fix() {
      await ready; checkRunning(); await refresh();
      if (reserved || job || saved.state.stage !== 'failure_observed' || saved.intent) throw new ReviewError(409, 'A repair requires one completed, failed rehearsal with no repair already in progress.');
      reserved = true;
      try {
        const pr = saved.state.pullRequest!;
        const runId = saved.state.originalRun!.id;
        const snapshot = await cloudMatches(runId, pr.headRef);
        if (reviewOutcome(snapshot) !== 'failed') throw new ReviewError(409, 'The original failed rollout is no longer available for repair.');
        saved.state.fix = { requestedModel: REPAIR_MODEL, reportedModel: null };
        await stage('generating', 'Asking live GPT-6 Astra to repair the observed failure using only the exact source and execution evidence.', { kind: 'generate', headRef: pr.headRef });
        launch(async () => {
          if (!sameRevision(pr, await backend.resolvePr(pr.url, abort.signal))) throw new ReviewError(409, 'The pull request changed after its rehearsal. The saved evidence cannot repair a different head.');
          const input = { pullRequest: pr, ...await backend.sources(pr, abort.signal), failures: failureEvidence(snapshot) };
          if (!input.failures.length) throw new ReviewError(409, 'There is no actual failed read or write evidence to send to Astra.');
          const patch = await backend.generate(input, abort.signal);
          saved.state.fix = { requestedModel: REPAIR_MODEL, reportedModel: patch.reportedModel, generatedAt: patch.generatedAt,
            summary: patch.summary, files: patch.files.map(file => file.path) };
          await stage('validating', 'Validating the generated files in an isolated checkout with TypeScript and immutable native PostgreSQL regression checks.', { kind: 'validate', headRef: pr.headRef });
          const prepared = await backend.prepare(pr, patch, saved.state.id!, abort.signal);
          saved.state.fix.validation = prepared.validation;
          saved.state.fix.commitSha = prepared.commitSha;
          if (!sameRevision(pr, await backend.resolvePr(pr.url, abort.signal)) || await backend.remoteHead(pr, abort.signal) !== pr.headRef)
            throw new ReviewError(409, 'The remote PR head changed before publication. The generated commit was not pushed.');
          await stage('publishing', 'Publishing the validated Astra commit to the same PR branch.', { kind: 'push', headRef: pr.headRef, commitSha: prepared.commitSha, oldRunId: runId });
          checkRunning();
          let uncertain = false;
          try { await backend.push(pr, prepared.commitSha, abort.signal); } catch { uncertain = true; }
          const actual = await backend.remoteHead(pr, abort.signal);
          if (actual !== prepared.commitSha) throw new ReviewError(409, uncertain
            ? 'The push response was uncertain and the exact commit is not the remote head. No push was retried.'
            : 'The published commit is no longer the exact remote PR head. No new sandbox pair was created.');
          saved.state.fix.commitUrl = `https://github.com/kllymx/gecco-rehearsals/commit/${prepared.commitSha}`;
          await persist();
          if ((await cloudMatches(runId, pr.headRef)).status !== 'completed') throw new ReviewError(409, 'The original pair was closed or changed during repair. The commit is published; no replacement was allocated.');
          await stage('rerunning', 'Deleting both original sandboxes before creating a fresh pair for the new commit.', { kind: 'cleanup', headRef: prepared.commitSha, commitSha: prepared.commitSha, oldRunId: runId });
          checkRunning(); await options.cloud.close(runId); await waitForDeletion(runId);
          await createRun(prepared.commitSha, true);
        });
        return present();
      } catch (error) { reserved = false; throw error; }
    },
    shutdown() { stopped = true; abort.abort(); if (timer) clearTimeout(timer); },
  };
}
