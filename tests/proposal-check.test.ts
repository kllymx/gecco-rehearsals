import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExactProposal, proposalCheckInput } from '../server/proposal-check.js';
import { REPAIR_PATHS, TRUSTED_REVIEW_BASE } from '../server/repair.js';
import { ProcessFailure, type runProcess } from '../server/process.js';

const candidateSha = 'b'.repeat(40);
const trustedSha = 'a'.repeat(40);
const release = await readFile(new URL('../apps/fieldnotes/release.ts', import.meta.url), 'utf8');
const files = new Map<string, string>([
  [REPAIR_PATHS[0], release], [REPAIR_PATHS[1], 'ALTER TABLE sessions ADD COLUMN identity_payload JSONB;'],
  [REPAIR_PATHS[2], 'ALTER TABLE sessions DROP COLUMN identity_payload;'],
  ['apps/fieldnotes/release.json', '{"release":"v2-breaking"}'],
]);
const recipe = [...REPAIR_PATHS, 'apps/fieldnotes/release.json', 'apps/fieldnotes/web/index.html', 'apps/fieldnotes/web/app.js', 'apps/fieldnotes/web/style.css'];
const digest = (source: string) => `sha256:${createHash('sha256').update(source).digest('hex')}`;
function nativeReport(passed = true) {
  return { scope: 'trusted_native_postgresql_proposal_contract', outcome: passed ? 'passed' : 'failed',
    checks: Array.from({ length: 15 }, (_, i) => ({ name: `Trusted contract ${i}`, passed: passed || i !== 3 })),
    proposal: { release: 'v2-breaking', releaseDigest: digest(files.get(REPAIR_PATHS[0])!),
      upDigest: digest(files.get(REPAIR_PATHS[1])!), downDigest: digest(files.get(REPAIR_PATHS[2])!), digest: `sha256:${'e'.repeat(64)}` },
    privateIgnoredField: 'not-part-of-the-public-receipt' };
}
async function fixture(t: { after(callback: () => Promise<void>): void }, mode: 'passed' | 'failed' | 'unknown' | 'bad-source' | 'moved' | 'inconsistent-exit' = 'passed') {
  const directory = await mkdtemp(join(tmpdir(), 'gecco-proposal-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: { command: string; args: string[] }[] = [];
  const runner: typeof runProcess = async (command, args, options) => {
    calls.push({ command, args });
    let stdout = '';
    if (command === 'gh') stdout = JSON.stringify({ state: 'open', number: 1, title: 'Public sample',
      base: { ref: 'codex/demo-pr-base', sha: TRUSTED_REVIEW_BASE, repo: { full_name: 'kllymx/gecco-rehearsals' } },
      head: { ref: 'codex/demo-pr-board', sha: candidateSha, repo: { full_name: 'kllymx/gecco-rehearsals' } } });
    else if (command === 'git') {
      if (args.includes('rev-parse')) stdout = args.includes('-C') ? candidateSha : trustedSha;
      else if (args.includes('diff')) stdout = recipe.join('\n');
      else if (args.includes('ls-tree')) stdout = recipe.map(path => `100644 blob ${candidateSha}\t${path}`).join('\n');
      else if (args.includes('show')) {
        const path = args.at(-1)!.split(':').slice(1).join(':');
        stdout = files.get(path) ?? 'trusted baseline source';
        if (mode === 'bad-source' && path === REPAIR_PATHS[0]) stdout = 'process.exit(0);';
      } else if (args.includes('worktree') && args.includes('add')) {
        await mkdir(join(args.at(-2)!, 'apps/fieldnotes'), { recursive: true });
      } else if (args.includes('worktree') && args.includes('remove')) await rm(args.at(-1)!, { recursive: true, force: true });
      else if (args.includes('ls-remote')) stdout = `${mode === 'moved' ? trustedSha : candidateSha}\trefs/heads/codex/demo-pr-board`;
    } else {
      assert.equal(command, process.execPath);
      assert.equal(options.env?.LC_ALL, 'C');
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'DAYTONA_API_KEY', 'HOME', 'CODEX_HOME']) assert.equal(options.env?.[key], undefined);
      if (args.includes('--import')) {
        assert.equal(args[2], join(process.cwd(), 'apps/fieldnotes/validate-proposal.ts'));
        assert.notEqual(options.cwd, args.at(-1));
        stdout = JSON.stringify(nativeReport(mode !== 'failed'));
        if (mode === 'failed' || mode === 'unknown' || mode === 'inconsistent-exit') throw new ProcessFailure(mode === 'unknown' ? 'timeout' : 'exit', 'not exported',
          { stdout, stderr: 'not exported', complete: mode !== 'unknown', exitCode: 1, signal: null });
      } else assert.match(args[0], /node_modules\/typescript\/bin\/tsc$/);
    }
    return { stdout, stderr: '' };
  };
  return { calls, options: { cwd: process.cwd(), candidateSha, prNumber: '1', receiptPath: join(directory, 'receipt.json'), runner } };
}
test('exact proposal input rejects refs, shell fragments, and nonnumeric PRs', () => {
  assert.deepEqual(proposalCheckInput(candidateSha, '1'), { candidateSha, prNumber: 1 });
  for (const [sha, pr] of [['main', '1'], [candidateSha, '1;echo'], [candidateSha, '01'], [candidateSha.toUpperCase(), '1']])
    assert.throws(() => proposalCheckInput(sha, pr));
});
test('trusted check pins source, strips credentials, retains all native checks and cleans candidate', async t => {
  const { calls, options } = await fixture(t);
  const receipt = await checkExactProposal(options);
  assert.equal(receipt.outcome, 'passed'); assert.equal(receipt.candidateSha, candidateSha);
  assert.equal(receipt.trustedHarnessSha, trustedSha); assert.equal(receipt.workflowAssociation, 'main');
  assert.equal(receipt.native?.checks.length, 15); assert.equal(receipt.typescript, 'passed');
  assert(calls.some(call => call.args.includes('worktree') && call.args.includes('remove')));
  const published = await readFile(options.receiptPath, 'utf8');
  assert(!published.includes('not-part-of-the-public-receipt')); assert(!published.includes('not exported'));
  assert(!published.includes(tmpdir()));
});
test('stale requested head or unsafe release never reaches candidate execution', async t => {
  for (const mode of ['passed', 'bad-source'] as const) {
    const { calls, options } = await fixture(t, mode);
    const receipt = await checkExactProposal({ ...options, candidateSha: mode === 'passed' ? trustedSha : candidateSha });
    assert.equal(receipt.outcome, 'inconclusive');
    assert(!calls.some(call => call.command === process.execPath));
    assert(!calls.some(call => call.args.includes('worktree')));
  }
});
test('completed native failure remains failed, uncertainty and moved head never pass', async t => {
  for (const mode of ['failed', 'unknown', 'moved', 'inconsistent-exit'] as const) {
    const { calls, options } = await fixture(t, mode);
    const receipt = await checkExactProposal(options);
    assert.equal(receipt.outcome, mode === 'failed' ? 'failed' : 'inconclusive');
    if (mode === 'failed') assert.equal(receipt.native?.checks.filter(check => !check.passed).length, 1);
    assert(calls.some(call => call.args.includes('worktree') && call.args.includes('remove')));
  }
});
