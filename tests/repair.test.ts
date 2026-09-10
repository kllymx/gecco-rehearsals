import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRepairBackend, parsePrUrl, parsePullRequest, parseRepair, REPAIR_PATHS, repairPrompt, cleanValidationEnvironment, TRUSTED_REVIEW_BASE } from '../server/repair.js';

const release = await readFile(new URL('../apps/fieldnotes/release.ts', import.meta.url), 'utf8');
const payload = () => ({ summary: 'Keep the existing reader contract', files: [
  { path: REPAIR_PATHS[0], content: release },
  { path: REPAIR_PATHS[1], content: 'ALTER TABLE sessions ADD COLUMN identity_payload JSONB;' },
  { path: REPAIR_PATHS[2], content: 'ALTER TABLE sessions DROP COLUMN identity_payload;' },
] });
test('repair parser accepts bounded full replacement files but rejects duplicate or arbitrary paths', () => {
  assert.equal(parseRepair(payload()).files.length, 3);
  const duplicate = payload(); duplicate.files[2] = duplicate.files[1]; assert.throws(() => parseRepair(duplicate));
  const escaped = payload(); escaped.files[0].path = '../../private' as typeof REPAIR_PATHS[0]; assert.throws(() => parseRepair(escaped));
  const oversized = payload(); oversized.files[0].content = 'x'.repeat(24_001); assert.throws(() => parseRepair(oversized));
});
test('repair parser rejects model runtime capabilities including parameter initializers and tagged templates', () => {
  for (const bad of [
    release.replace('id: string)', 'id: string, extra = process.cwd())'),
    release.replace('id: string)', 'id: string = globalThis.secret)'),
    release.replace('const { rows }', 'fetch`https://example.com`; const { rows }'),
    release.replace('const { rows }', 'const x = { get value() { return 1; } }; const { rows }'),
    release.replace('const { rows }', 'function inner() { return 1; } const { rows }'),
    release.replace('const { rows }', 'const x = process.env; const { rows }'),
    release.replace('JSON.stringify', 'eval'),
    release.replace('const { rows }', 'const JSON = { stringify: fetch as any }; const { rows }'),
    release.replace('const { rows }', 'JSON.stringify = fetch as any; const { rows }'),
    release.replace('const { rows }', 'const secret = fetch; const { rows }'),
  ]) { const data = payload(); data.files[0].content = bad; assert.throws(() => parseRepair(data)); }
});
test('repair parser rejects external SQL execution and unparameterized queries', () => {
  for (const sql of ["COPY sessions TO PROGRAM 'echo bad'", 'DO $$ BEGIN END $$;', 'CREATE FUNCTION bad() RETURNS void AS $$ SELECT 1 $$ LANGUAGE SQL;', 'DELETE FROM sessions;']) {
    const data = payload(); data.files[1].content = sql; assert.throws(() => parseRepair(data));
  }
  const data = payload(); data.files[0].content = release.replace('WHERE id = $1', "WHERE id = 'constant'"); assert.throws(() => parseRepair(data));
  for (const sql of ['SELECT id, set_config(\'a\',\'b\',false) FROM sessions WHERE id = $1', 'SELECT id FROM sessions WHERE id = $1; DROP TABLE notes', 'INSERT INTO notes(id) VALUES($1)', 'SELECT (SELECT note FROM notes) FROM sessions WHERE id = $1']) {
    const unsafe = payload(); unsafe.files[0].content = release.replace('SELECT id, session_payload FROM sessions WHERE id = $1', sql.replaceAll("'", "\\'")); assert.throws(() => parseRepair(unsafe));
  }
});
test('only open same-repository sample PRs with pinned SHAs resolve', () => {
  const raw = { state: 'open', number: 7, title: 'Sample', base: { ref: 'codex/demo-pr-base', sha: TRUSTED_REVIEW_BASE, repo: { full_name: 'kllymx/gecco-rehearsals' } },
    head: { ref: 'codex/demo-pr-feature', sha: 'b'.repeat(40), repo: { full_name: 'kllymx/gecco-rehearsals' } } };
  assert.equal(parsePullRequest(raw, 7).headRef, 'b'.repeat(40));
  assert.throws(() => parsePullRequest({ ...raw, state: 'closed' }, 7));
  assert.throws(() => parsePullRequest({ ...raw, head: { ...raw.head, repo: { full_name: 'someone/fork' } } }, 7));
  assert.throws(() => parsePullRequest({ ...raw, head: { ...raw.head, ref: 'main' } }, 7));
  assert.throws(() => parsePrUrl('https://github.com/kllymx/gecco-rehearsals/pull/7?command=bad'));
});
test('live runner explicitly requests Astra and disables tools, plugins, hooks, web and project instructions', async () => {
  let called = false;
  const backend = createRepairBackend({ cwd: process.cwd(), stateDirectory: '/tmp/unused-review-test', command: '/trusted/codex',
    async runner(command, args, options) {
      called = true; assert.equal(command, '/trusted/codex');
      assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
      for (const name of ['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use']) assert.ok(args.some((arg, i) => arg === '--disable' && args[i + 1] === name));
      assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('read-only')); assert.ok(args.includes('project_doc_max_bytes=0'));
      assert.match(options.input!, /UNTRUSTED DATA/);
      return { stdout: JSON.stringify(payload()), stderr: 'model: gpt-6-astra\n' };
    } });
  const result = await backend.generate({ pullRequest: { url: 'https://github.com/kllymx/gecco-rehearsals/pull/1', number: 1, title: 'Demo', baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40), headBranch: 'codex/demo-pr-demo' }, base: [], head: [], failures: [] });
  assert.equal(called, true); assert.equal(result.reportedModel, 'gpt-6-astra');
});
test('model mismatch is not silently relabeled Astra and prompts contain only explicitly supplied sources', async () => {
  const input = { pullRequest: { url: 'https://github.com/kllymx/gecco-rehearsals/pull/1', number: 1, title: 'Demo', baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40), headBranch: 'codex/demo-pr-demo' },
    base: [{ path: 'base', content: 'BASEONLY' }], head: [{ path: 'head', content: 'HEADONLY' }], failures: [{ error: 'ACTUALFAILURE' }] };
  const prompt = repairPrompt(input); assert.match(prompt, /BASEONLY/); assert.match(prompt, /HEADONLY/); assert.match(prompt, /ACTUALFAILURE/);
  const backend = createRepairBackend({ cwd: process.cwd(), stateDirectory: '/tmp/unused-review-test', command: 'codex',
    async runner() { return { stdout: JSON.stringify(payload()), stderr: 'model: a-different-model\n' }; } });
  await assert.rejects(backend.generate(input), /different model/);
});
test('candidate validation receives no inherited provider, GitHub, or Codex credentials', () => {
  const environment = cleanValidationEnvironment();
  assert.equal(environment.DAYTONA_API_KEY, undefined); assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.GH_TOKEN, undefined); assert.equal(environment.CODEX_HOME, undefined); assert.equal(environment.HOME, undefined);
});
