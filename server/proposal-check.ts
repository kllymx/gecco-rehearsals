import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cleanValidationEnvironment, createRepairBackend, parseRepair, ReviewError } from './repair.js';
import { ProcessFailure, runProcess } from './process.js';
import type { ReviewPullRequest } from '../shared/review.js';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export function proposalCheckInput(candidateSha: unknown, prNumber: unknown) {
  if (typeof candidateSha !== 'string' || !/^[a-f0-9]{40}$/.test(candidateSha)
    || typeof prNumber !== 'string' || !/^[1-9][0-9]{0,7}$/.test(prNumber))
    throw new ReviewError(400, 'Provide an exact lowercase commit SHA and a public sample PR number.');
  return { candidateSha, prNumber: Number(prNumber) };
}
interface NativeSummary {
  scope: string; outcome: 'passed' | 'failed' | 'inconclusive';
  checks: { name: string; passed: boolean }[];
  proposal: { release: string; releaseDigest: string; upDigest: string; downDigest: string; digest: string };
}
interface ProposalCheckReceipt {
  schemaVersion: 1; scope: 'trusted_main_exact_proposal'; workflowAssociation: 'main';
  candidateSha: string; trustedHarnessSha: string | null; trustedHarnessDirty: boolean; pullRequest: ReviewPullRequest | null;
  checkedAt: string; outcome: 'passed' | 'failed' | 'inconclusive';
  typescript: 'not-run' | 'passed'; native: NativeSummary | null; nativeReceiptDigest: string | null;
  error?: string;
}

/** Read-only PR verification and native execution: no model, commit, push, or cloud. */
export async function checkExactProposal(options: {
  cwd: string; candidateSha: string; prNumber: string; receiptPath: string; runner?: typeof runProcess;
}): Promise<ProposalCheckReceipt> {
  const input = proposalCheckInput(options.candidateSha, options.prNumber);
  const run = options.runner ?? runProcess;
  const cwd = resolve(options.cwd);
  const receipt: ProposalCheckReceipt = {
    schemaVersion: 1, scope: 'trusted_main_exact_proposal', workflowAssociation: 'main',
    candidateSha: input.candidateSha, trustedHarnessSha: null, trustedHarnessDirty: false, pullRequest: null,
    checkedAt: new Date().toISOString(), outcome: 'inconclusive', typescript: 'not-run', native: null, nativeReceiptDigest: null,
  };
  const git = (args: string[]) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, timeoutMs: 60_000, maxOutputBytes: 200_000 });
  let temporary: string | undefined;
  let checkout: string | undefined;
  let attached = false;
  try {
    receipt.trustedHarnessSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    receipt.trustedHarnessDirty = (await git(['status', '--porcelain'])).stdout.trim() !== '';
    if (!/^[a-f0-9]{40}$/.test(receipt.trustedHarnessSha)) throw new ReviewError(422, 'The trusted harness commit could not be identified.');
    // resolvePr and sources both enforce the fixed base, same-repository open
    // PR, seven allowed regular blobs, and unchanged package/config/type files.
    const backend = createRepairBackend({ cwd, stateDirectory: dirname(resolve(options.receiptPath)), runner: run });
    const pr = await backend.resolvePr(`https://github.com/kllymx/gecco-rehearsals/pull/${input.prNumber}`);
    receipt.pullRequest = pr;
    if (pr.headRef !== input.candidateSha) throw new ReviewError(409, 'The requested commit is not the current exact PR head.');
    const sources = await backend.sources(pr);
    const parsed = parseRepair({ summary: 'Validate the exact published proposal without generating or changing it.', files: sources.head });
    temporary = await mkdtemp(join(tmpdir(), 'gecco-proposal-check-'));
    checkout = join(temporary, 'candidate');
    await git(['worktree', 'add', '--detach', checkout, input.candidateSha]); attached = true;
    const checkedOut = (await git(['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim();
    if (checkedOut !== input.candidateSha) throw new ReviewError(422, 'The candidate checkout is not the requested exact commit.');
    await symlink(join(cwd, 'node_modules'), join(checkout, 'node_modules'), 'dir');
    await symlink(join(cwd, 'apps/fieldnotes/node_modules'), join(checkout, 'apps/fieldnotes/node_modules'), 'dir');
    const env = cleanValidationEnvironment();
    // The candidate supplies source only. All tools/dependencies and the native
    // oracle come from trusted main; GitHub/provider credentials are omitted.
    for (const config of ['tsconfig.json', 'apps/fieldnotes/tsconfig.json']) {
      await run(process.execPath, [join(cwd, 'node_modules/typescript/bin/tsc'), '--noEmit', '--project', join(checkout, config)],
        { cwd: checkout, env, timeoutMs: 60_000, maxOutputBytes: 32_000 });
    }
    receipt.typescript = 'passed';
    let raw: string;
    let nativeExitFailed = false;
    try {
      raw = (await run(process.execPath, ['--import', 'tsx', join(cwd, 'apps/fieldnotes/validate-proposal.ts'), checkout],
        { cwd, env, timeoutMs: 90_000, maxOutputBytes: 1_000_000 })).stdout.trim();
    } catch (error) {
      if (!(error instanceof ProcessFailure) || error.kind !== 'exit' || !error.capture?.complete) throw error;
      nativeExitFailed = true;
      raw = error.capture.stdout.trim();
    }
    const native = JSON.parse(raw) as NativeSummary;
    if (native.scope !== 'trusted_native_postgresql_proposal_contract'
      || !['passed', 'failed', 'inconclusive'].includes(native.outcome)
      || !Array.isArray(native.checks) || native.checks.length !== 15
      || new Set(native.checks.map(check => check.name)).size !== 15
      || native.checks.some(check => typeof check.name !== 'string' || check.name.length > 200 || typeof check.passed !== 'boolean')
      || native.proposal?.release !== 'v2-breaking'
      || native.proposal.releaseDigest !== digest(parsed.files.find(file => file.path.endsWith('release.ts'))!.content)
      || native.proposal.upDigest !== digest(parsed.files.find(file => file.path.endsWith('up.sql'))!.content)
      || native.proposal.downDigest !== digest(parsed.files.find(file => file.path.endsWith('down.sql'))!.content)
      || !/^sha256:[a-f0-9]{64}$/.test(native.proposal.digest))
      throw new ReviewError(422, 'The native receipt does not match the exact proposal or complete trusted contract.');
    // Publish only the contract/source summary, never inherited environment,
    // command output, administrative URLs, or runner credentials.
    receipt.native = { scope: native.scope, outcome: native.outcome,
      checks: native.checks.map(({ name, passed }) => ({ name, passed })),
      proposal: { release: native.proposal.release, releaseDigest: native.proposal.releaseDigest,
        upDigest: native.proposal.upDigest, downDigest: native.proposal.downDigest, digest: native.proposal.digest } };
    receipt.nativeReceiptDigest = digest(raw);
    receipt.outcome = native.outcome === 'passed' && nativeExitFailed ? 'inconclusive'
      : native.outcome === 'passed' && native.checks.every(check => check.passed) ? 'passed'
      : native.outcome === 'inconclusive' ? 'inconclusive' : 'failed';
    if (await backend.remoteHead(pr) !== input.candidateSha) throw new ReviewError(409, 'The PR head moved while validation was running.');
  } catch (error) {
    receipt.outcome = 'inconclusive';
    receipt.error = error instanceof ReviewError ? error.message : 'The bounded trusted proposal validation did not complete.';
  } finally {
    try {
      if (attached) await git(['worktree', 'remove', '--force', checkout!]);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } catch {
      receipt.outcome = 'inconclusive'; receipt.error = 'Temporary candidate cleanup could not be verified.';
    }
    receipt.checkedAt = new Date().toISOString();
    await mkdir(dirname(resolve(options.receiptPath)), { recursive: true });
    await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
  }
  return receipt;
}
