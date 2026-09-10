import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexProviderError, parseProviderEnvironment, resolveCodexProvider, runWithCodexProvider } from '../server/codex-provider.js';
import { createCodexAnalysis } from '../server/ai.js';
import { createRepairBackend, TRUSTED_REVIEW_BASE } from '../server/repair.js';
import { ProcessFailure } from '../server/process.js';
import type { Specimen } from '../shared/contracts.js';

const key = 'test-only-credential+with/symbols';
const settings = { OPENAI_BASE_URL: 'https://proxy.example.test:8443/v1', OPENAI_API_KEY: key };
const specimen: Specimen = { id: 'provider-test', title: 'Test', description: 'Public fixture', contract: 'Keep the reader working',
  currentRelease: 'v1', proposedRelease: 'v2', files: [] };
const input = { pullRequest: { url: 'https://github.com/kllymx/gecco-rehearsals/pull/1', number: 1, title: 'Demo',
  baseRef: TRUSTED_REVIEW_BASE, headRef: 'b'.repeat(40), headBranch: 'codex/demo-pr-demo' }, base: [], head: [], failures: [] };

test('explicit provider sends the key only through env and disables native auth, WebSockets and retries', async () => {
  const source = { ...settings };
  const provider = await resolveCodexProvider({ environment: source });
  assert.equal(provider.mode, 'custom'); assert.equal(provider.environment.OPENAI_API_KEY, key);
  const args = provider.args.join('\n'); assert.ok(!args.includes(key));
  for (const setting of ['model_provider="gecco_explicit"', 'env_key="OPENAI_API_KEY"', 'wire_api="responses"',
    'requires_openai_auth=false', 'supports_websockets=false', 'request_max_retries=0', 'stream_max_retries=0']) assert.ok(args.includes(setting));
  assert.deepEqual(source, settings);
  let calls = 0;
  const result = await runWithCodexProvider(provider, '/mock/codex', ['exec', '--ignore-user-config', '--model', 'gpt-6-astra', '-'],
    { cwd: process.cwd(), timeoutMs: 1000, input: 'PUBLIC SOURCE' }, async (_command, actual, options) => {
      calls++; assert.ok(!actual.join(' ').includes(key)); assert.equal(options.env?.OPENAI_API_KEY, key);
      assert.equal(actual[actual.indexOf('--model') + 1], 'gpt-6-astra');
      return { stdout: '{"ok":true}', stderr: `credential=${key}` };
    });
  assert.equal(calls, 1); assert.ok(!result.stderr.includes(key));
});
test('explicit file imports only OpenAI fields literally and rereads rotated credentials without mutations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gecco-provider-env-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'provider.env'), auth = join(directory, 'auth.json'), config = join(directory, 'config.toml');
  await writeFile(auth, 'original auth'); await writeFile(config, 'original config');
  await writeFile(path, `OPENAI_BASE_URL=${settings.OPENAI_BASE_URL}\nexport OPENAI_API_KEY='${key}'\nDAYTONA_API_KEY=never-import\nCODEX_HOME=never-import\nsh -c 'touch forbidden'\n`, { mode: 0o600 });
  const environment = { GECCO_AI_ENV_FILE: path, OPENAI_API_KEY: 'old-key', CODEX_HOME: directory };
  const first = await resolveCodexProvider({ environment });
  assert.equal(first.environment.OPENAI_API_KEY, key); assert.equal(first.environment.DAYTONA_API_KEY, undefined);
  assert.equal(first.environment.CODEX_HOME, directory); assert.equal(environment.OPENAI_API_KEY, 'old-key');
  await writeFile(path, `OPENAI_BASE_URL=${settings.OPENAI_BASE_URL}\nOPENAI_API_KEY=rotated-test-key\n`);
  assert.equal((await resolveCodexProvider({ environment })).environment.OPENAI_API_KEY, 'rotated-test-key');
  assert.equal(await readFile(auth, 'utf8'), 'original auth'); assert.equal(await readFile(config, 'utf8'), 'original config');
  assert.deepEqual((await readdir(directory)).sort(), ['auth.json', 'config.toml', 'provider.env']);
});
test('literal-only file parsing does not expand commands, variables or unrelated settings', () => {
  const values = parseProviderEnvironment('OPENAI_API_KEY="$(whoami)"\nOTHER=$(touch forbidden)\nOPENAI_BASE_URL=\'https://example.test/v1\' # note\n');
  assert.equal(values.OPENAI_API_KEY, '$(whoami)'); assert.deepEqual(Object.keys(values).sort(), ['OPENAI_API_KEY', 'OPENAI_BASE_URL']);
  assert.throws(() => parseProviderEnvironment('OPENAI_API_KEY=a\nOPENAI_API_KEY=b'), /duplicate/);
});
test('missing, malformed and incomplete explicit settings fail without native fallback', async t => {
  for (const environment of [{ OPENAI_BASE_URL: settings.OPENAI_BASE_URL }, { OPENAI_API_KEY: key },
    { ...settings, OPENAI_BASE_URL: 'https://secret@example.test/v1' }, { ...settings, OPENAI_BASE_URL: 'http://remote.example/v1' },
    { ...settings, OPENAI_BASE_URL: 'https://example.test/v1?token=secret' }])
    await assert.rejects(resolveCodexProvider({ environment }), CodexProviderError);
  await assert.rejects(resolveCodexProvider({ environment: { ...settings, GECCO_AI_ENV_FILE: '/nonexistent/gecco-provider-test' } }), /No alternate/);
  const directory = await mkdtemp(join(tmpdir(), 'gecco-provider-bounded-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'oversized.env'); await writeFile(path, 'x'.repeat(65_537));
  await assert.rejects(resolveCodexProvider({ environment: { ...settings }, envFile: path }), /64 KiB/);
  assert.equal((await resolveCodexProvider({ environment: {} })).mode, 'native');
});
test('runner failures redact raw and encoded keys before exposing captured output or error details', async () => {
  const provider = await resolveCodexProvider({ environment: settings });
  const unsafe = `${key} ${encodeURIComponent(key)} Bearer another-test-token`;
  await assert.rejects(runWithCodexProvider(provider, '/mock/codex', [], { cwd: process.cwd(), timeoutMs: 1000 },
    async () => { throw new ProcessFailure('exit', unsafe, { stdout: unsafe, stderr: unsafe, complete: true, exitCode: 1, signal: null }); }),
  (error: unknown) => {
    assert.ok(error instanceof ProcessFailure);
    const text = JSON.stringify(error); assert.ok(!text.includes(key)); assert.ok(!text.includes(encodeURIComponent(key))); assert.ok(!text.includes('another-test-token'));
    assert.equal(error.capture?.complete, true); return true;
  });
});
test('repair uses the explicit adapter once and privately saves only redacted failed output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gecco-provider-repair-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const backend = createRepairBackend({ cwd: process.cwd(), stateDirectory: directory, command: '/mock/codex', provider: { environment: settings },
    async runner(_command, args, options) {
      calls++; assert.ok(args.join(' ').includes('requires_openai_auth=false')); assert.ok(args.includes('gpt-6-astra'));
      assert.ok(!args.join(' ').includes(key)); assert.equal(options.env?.OPENAI_API_KEY, key);
      const stderr = `provider request failed, token=${key}`;
      throw new ProcessFailure('exit', stderr, { stdout: '', stderr, exitCode: 1, signal: null, complete: true });
    } });
  await assert.rejects(backend.generate(input), ProcessFailure); assert.equal(calls, 1);
  const files = await readdir(directory); assert.equal(files.length, 1);
  assert.ok(!(await readFile(join(directory, files[0]), 'utf8')).includes(key));
});
test('incomplete repair and analysis configurations never invoke login or inference', async () => {
  let calls = 0;
  const runner = async () => { calls++; return { stdout: '', stderr: '' }; };
  const provider = { environment: { OPENAI_BASE_URL: settings.OPENAI_BASE_URL } };
  const backend = createRepairBackend({ cwd: process.cwd(), stateDirectory: '/tmp/unused-gecco-provider', command: '/mock/codex', provider, runner });
  await assert.rejects(backend.generate(input), /requires both/);
  const analysis = createCodexAnalysis({ cwd: process.cwd(), command: '/mock/codex', provider, runner });
  assert.equal((await analysis.health()).available, false);
  const result = await analysis.analyze(specimen, 'breaking'); assert.equal(result.status, 'unavailable'); assert.match(result.error!, /requires both/);
  assert.equal(calls, 0);
});
test('custom analysis checks runner availability without native login and preserves explicit Astra', async () => {
  const calls: string[][] = [];
  const analysis = createCodexAnalysis({ cwd: process.cwd(), command: '/mock/codex', provider: { environment: settings },
    async runner(_command, args, options) {
      calls.push(args); assert.equal(options.env?.OPENAI_API_KEY, key); assert.ok(!args.includes('login'));
      if (args.includes('--version')) return { stdout: 'codex test', stderr: '' };
      assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
      return { stdout: JSON.stringify({ summary: 'A prediction', suggestedFix: 'Keep the old reader contract.',
        hypotheses: ['control', 'upgrade', 'mixed', 'rollback'].map(scenarioId => ({ scenarioId, risk: 'Possible risk', rationale: 'Source-based hypothesis' })) }),
        stderr: 'model: gpt-6-astra' };
    } });
  const result = await analysis.analyze(specimen, 'breaking'); assert.equal(result.status, 'completed');
  assert.equal(result.model, 'gpt-6-astra'); assert.equal(calls.length, 2); assert.match(result.provider, /Configured Responses/);
});
