import { createHash } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { CreateSandboxFromImageParams, Daytona, Sandbox } from '@daytona/sdk';

// This is a server-only adapter for trusted application code, never an HTTP command API.
// SDK contracts: https://www.daytona.io/docs/en/typescript-sdk/daytona/
// Preview auth: https://www.daytona.io/docs/en/preview/
export type DaytonaSide = 'left' | 'right';
export type DaytonaSandbox = Pick<Sandbox, 'id' | 'name' | 'state' | 'labels' | 'public' | 'cpu' | 'memory' | 'disk'
  | 'stop' | 'delete' | 'getPreviewLink' | 'getSignedPreviewUrl'> & {
  process: Pick<Sandbox['process'], 'executeCommand'>;
  fs: Pick<Sandbox['fs'], 'uploadFiles'>;
};
export interface DaytonaClient {
  create(params: CreateSandboxFromImageParams, options: { timeout: number }): Promise<DaytonaSandbox>;
  get(idOrName: string): Promise<DaytonaSandbox>;
}
// Compiled against the real pinned SDK; mocks implement the same narrow contract.
export function daytonaClient(client: Daytona): DaytonaClient { return client; }

export interface DaytonaProviderOptions {
  client: DaytonaClient;
  stateDirectory: string;
  namespace: string;
  image: string;
  /** Execution user is trusted server configuration, never client input. */
  user?: string;
  workDirectory?: string;
  /** Network policy for installing public dependencies; supplied only by server configuration. */
  domainAllowList?: string;
  limits?: Partial<{ cpu: number; memory: number; disk: number; createSeconds: number;
    operationSeconds: number; cleanupSeconds: number; maxOutputBytes: number }>;
}
export interface DaytonaSandboxView {
  side: DaytonaSide;
  name: string;
  id: string | null;
  state: string;
  resources: { cpu: number; memory: number; disk: number } | null;
}
export interface DaytonaPairView {
  experimentId: string;
  left: DaytonaSandboxView;
  right: DaytonaSandboxView;
}
export interface DaytonaCommand {
  /** A retry must reuse this ID and exactly the same input. Unknown outcomes are never replayed. */
  operationId: string;
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
}
export interface DaytonaCommandResult {
  operationId: string;
  exitCode: number;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  completedAt: string;
}
export interface DaytonaCleanupSide {
  side: DaytonaSide;
  name: string;
  id: string | null;
  state: 'deleted' | 'never-created' | 'uncertain';
  stoppedVerified: boolean;
  deletedVerified: boolean;
}
export class DaytonaProviderError extends Error {
  constructor(public readonly code: 'invalid-input' | 'busy' | 'capacity' | 'ownership' | 'uncertain'
    | 'closed' | 'not-ready' | 'configuration' | 'provider', message: string) { super(message); }
}
const sides = ['left', 'right'] as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const timestamp = () => new Date().toISOString();
const missing = (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error
  && (error.statusCode === 404 || error.statusCode === 410);
const fsMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function check(value: unknown, message: string): asserts value {
  if (!value) throw new DaytonaProviderError('invalid-input', message);
}
interface PairIntent { version: 1; experimentId: string; key: string; configuration: string; createdAt: string }
interface Created { id: string; observedAt: string }

/** Exactly one live pair per state directory. Use one coordinator process for this directory.
 * Immutable, fsynced attempt records also prevent blind create/command replay after restart.
 * A local timeout never proves the remote operation was cancelled. SDK-side timeouts bound
 * commands; auto-stop and TTL are remote safety nets, not cleanup receipts.
 */
export function createDaytonaProvider(options: DaytonaProviderOptions) {
  check(/^[a-z0-9][a-z0-9-]{2,63}$/.test(options.namespace), 'Invalid Daytona namespace.');
  check(typeof options.image === 'string' && options.image.length > 0 && options.image.length <= 512
    && !/[\s\x00-\x1f]/.test(options.image), 'A trusted image reference is required.');
  check(options.user === undefined || /^[a-z_][a-z0-9_-]{0,31}$/.test(options.user), 'Invalid execution user.');
  const limits = { cpu: 1, memory: 2, disk: 3, createSeconds: 180, operationSeconds: 120,
    cleanupSeconds: 60, maxOutputBytes: 64 * 1024, ...options.limits };
  for (const [key, max] of Object.entries({ cpu: 1, memory: 2, disk: 3, createSeconds: 300,
    operationSeconds: 300, cleanupSeconds: 120, maxOutputBytes: 1024 * 1024 })) {
    const value = limits[key as keyof typeof limits];
    check(Number.isInteger(value) && value >= 1 && value <= max, `Invalid ${key} bound.`);
  }
  const workDirectory = options.workDirectory ?? '/home/daytona/gecco';
  check(workDirectory.startsWith('/') && posix.normalize(workDirectory) === workDirectory
    && workDirectory !== '/' && !/[\x00-\x1f\x7f]/.test(workDirectory), 'Invalid work directory.');
  const configuration = hash(JSON.stringify({ namespace: options.namespace, image: options.image, user: options.user,
    workDirectory, domainAllowList: options.domainAllowList, limits }));
  const owner = hash(options.namespace).slice(0, 24);
  const inFlight = new Set<string>();
  const pendingRemote = new Set<Promise<unknown>>();

  async function load<T>(path: string): Promise<T | null> {
    try {
      const handle = await open(path, 'r');
      try { check((await handle.stat()).size <= 2 * 1024 * 1024, 'Provider record is too large.');
        return JSON.parse(await handle.readFile('utf8')) as T; } finally { await handle.close(); }
    } catch (error) { if (fsMissing(error)) return null; throw error; }
  }
  async function once(path: string, value: unknown): Promise<boolean> {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    const directory = await open(posix.dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }
  function identity(experimentId: string) {
    check(typeof experimentId === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(experimentId), 'Invalid experiment ID.');
    const key = hash(`${options.namespace}:${experimentId}`).slice(0, 32);
    return { key, directory: join(options.stateDirectory, key), name: (side: DaytonaSide) => `gecco-${key}-${side}` };
  }
  function sideCheck(side: DaytonaSide) { check(sides.includes(side), 'Invalid sandbox side.'); }
  async function localIntent(experimentId: string): Promise<PairIntent> {
    const { directory, key } = identity(experimentId);
    const intent = await load<PairIntent>(join(directory, 'intent.json'));
    if (!intent) throw new DaytonaProviderError('not-ready', 'This sandbox pair has not been requested.');
    if (intent.configuration !== configuration || intent.experimentId !== experimentId || intent.key !== key)
      throw new DaytonaProviderError('configuration', 'The saved pair belongs to different provider configuration.');
    return intent;
  }
  async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (inFlight.has(key) || (key !== 'lifecycle' && inFlight.has('lifecycle')))
      throw new DaytonaProviderError('busy', 'A sandbox operation is already running.');
    inFlight.add(key);
    try { return await operation(); } finally { inFlight.delete(key); }
  }
  async function bounded<T>(operation: Promise<T>, seconds: number): Promise<T> {
    pendingRemote.add(operation);
    void operation.then(() => pendingRemote.delete(operation), () => pendingRemote.delete(operation));
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DaytonaProviderError('uncertain',
        'Daytona did not answer before the deadline; remote completion is unknown.')), seconds * 1000);
    })]); } finally { clearTimeout(timer!); }
  }
  function labels(key: string, side: DaytonaSide) {
    return { 'gecco-provider': 'paired-app-v1', 'gecco-owner': owner, 'gecco-experiment': key, 'gecco-side': side };
  }
  function verify(sandbox: DaytonaSandbox, experimentId: string, side: DaytonaSide, knownId?: string, enforceBounds = true) {
    const info = identity(experimentId);
    if (sandbox.name !== info.name(side) || (knownId && sandbox.id !== knownId)
      || Object.entries(labels(info.key, side)).some(([key, value]) => sandbox.labels[key] !== value))
      throw new DaytonaProviderError('ownership', 'Sandbox identity or ownership labels do not match this experiment.');
    if (enforceBounds && (sandbox.public || sandbox.cpu > limits.cpu || sandbox.memory > limits.memory || sandbox.disk > limits.disk))
      throw new DaytonaProviderError('configuration', 'Sandbox privacy or resource bounds do not match.');
    return sandbox;
  }
  async function lookup(experimentId: string, side: DaytonaSide, enforceBounds = true): Promise<DaytonaSandbox | null> {
    const info = identity(experimentId);
    const known = await load<Created>(join(info.directory, `${side}.created.json`));
    try { return verify(await bounded(options.client.get(known?.id ?? info.name(side)), 30), experimentId, side, known?.id, enforceBounds); }
    catch (error) { if (missing(error)) return null;
      if (error instanceof DaytonaProviderError) throw error;
      throw new DaytonaProviderError('provider', 'Could not inspect the Daytona sandbox.'); }
  }
  function view(experimentId: string, side: DaytonaSide, sandbox: DaytonaSandbox | null, state = 'missing'): DaytonaSandboxView {
    return { side, name: identity(experimentId).name(side), id: sandbox?.id ?? null, state: sandbox?.state ?? state,
      resources: sandbox ? { cpu: sandbox.cpu, memory: sandbox.memory, disk: sandbox.disk } : null };
  }
  async function inspectPair(experimentId: string): Promise<DaytonaPairView> {
    await localIntent(experimentId);
    const { directory } = identity(experimentId);
    const values = await Promise.all(sides.map(async side => {
      const sandbox = await lookup(experimentId, side);
      const attempted = await load(join(directory, `${side}.requested.json`));
      const deleted = await load(join(directory, `${side}.deleted.json`));
      return view(experimentId, side, sandbox, deleted ? 'deleted' : attempted ? 'uncertain' : 'not-created');
    }));
    return { experimentId, left: values[0], right: values[1] };
  }
  async function ensurePair(experimentId: string): Promise<DaytonaPairView> {
    const info = identity(experimentId);
    return exclusive('lifecycle', async () => {
      if (sides.some(side => inFlight.has(`${info.key}:${side}`)))
        throw new DaytonaProviderError('busy', 'A sandbox operation is already running.');
      if (await load(join(info.directory, 'closing.json'))) throw new DaytonaProviderError('closed', 'This experiment is closing or closed.');
      await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
      await once(join(options.stateDirectory, 'active-pair.json'), { key: info.key });
      const active = await load<{ key: string }>(join(options.stateDirectory, 'active-pair.json'));
      if (active?.key !== info.key) throw new DaytonaProviderError('capacity', 'Close the existing two-sandbox experiment first.');
      await mkdir(info.directory, { recursive: true, mode: 0o700 });
      await once(join(info.directory, 'intent.json'), { version: 1, experimentId, key: info.key, configuration, createdAt: timestamp() });
      await localIntent(experimentId);
      if (await load(join(info.directory, 'closing.json'))) throw new DaytonaProviderError('closed', 'This experiment is closing or closed.');
      for (const side of sides) {
        let sandbox = await lookup(experimentId, side);
        if (!sandbox) {
          const fresh = await once(join(info.directory, `${side}.requested.json`), { name: info.name(side), requestedAt: timestamp() });
          if (!fresh) throw new DaytonaProviderError('uncertain', 'An earlier create may have reached Daytona. Inspect or clean up this experiment; do not recreate it.');
          const params: CreateSandboxFromImageParams = { name: info.name(side), image: options.image, language: 'typescript',
            public: false, labels: labels(info.key, side), resources: { cpu: limits.cpu, memory: limits.memory, disk: limits.disk },
            autoStopInterval: 15, autoDeleteInterval: 0, ttlMinutes: 60,
            ...(options.user ? { user: options.user } : {}),
            ...(options.domainAllowList ? { domainAllowList: options.domainAllowList } : {}) };
          try {
            sandbox = verify(await bounded(options.client.create(params, { timeout: limits.createSeconds }), limits.createSeconds + 5), experimentId, side);
          } catch (error) {
            // Reconcile the deterministic name once. A 404 after a timeout is not proof of no create.
            sandbox = await lookup(experimentId, side);
            if (!sandbox) throw new DaytonaProviderError('uncertain', 'Sandbox creation was not confirmed. Its original intent is retained for reconciliation.');
          }
        }
        await once(join(info.directory, `${side}.created.json`), { id: sandbox.id, observedAt: timestamp() });
        if (sandbox.state !== 'started') throw new DaytonaProviderError('not-ready', `The ${side} sandbox is not started; inspect its existing state.`);
      }
      return inspectPair(experimentId);
    });
  }
  async function ready(experimentId: string, side: DaytonaSide) {
    sideCheck(side); await localIntent(experimentId);
    const { directory } = identity(experimentId);
    if (await load(join(directory, 'closing.json'))) throw new DaytonaProviderError('closed', 'This experiment is closing or closed.');
    const sandbox = await lookup(experimentId, side);
    if (!sandbox || sandbox.state !== 'started') throw new DaytonaProviderError('not-ready', 'The sandbox is not running.');
    return sandbox;
  }
  function remotePath(path: string) {
    check(typeof path === 'string' && path.length <= 240 && path.length > 0 && !path.startsWith('/')
      && posix.normalize(path) === path && !path.split('/').some(part => part === '.' || part === '..' || part === '')
      && !/[\x00-\x1f\x7f]/.test(path), 'Invalid relative upload path.');
    return `${workDirectory}/${path}`;
  }
  async function writable(experimentId: string, side: DaytonaSide) {
    const directory = identity(experimentId).directory;
    if (await load(join(directory, `${side}.upload-pending.json`)))
      throw new DaytonaProviderError('uncertain', 'An earlier upload has an unknown outcome. Inspect or close the experiment first.');
    const pendingPath = join(directory, 'commands', `${side}.pending.json`);
    const pending = await load<{ operationId: string }>(pendingPath);
    if (pending) {
      const result = await load<DaytonaCommandResult>(join(directory, 'commands', `${side}-${hash(pending.operationId)}.result.json`));
      if (!result) throw new DaytonaProviderError('uncertain', 'An earlier command has an unknown outcome. Inspect or close the experiment first.');
      await unlink(pendingPath);
    }
  }
  async function uploadFiles(experimentId: string, side: DaytonaSide, files: Array<{ path: string; bytes: Uint8Array }>) {
    check(Array.isArray(files) && files.length >= 1 && files.length <= 64, 'Upload requires 1–64 trusted files.');
    const mapped = files.map(file => ({ destination: remotePath(file.path), source: Buffer.from(file.bytes) }));
    check(new Set(mapped.map(file => file.destination)).size === mapped.length, 'Duplicate upload paths.');
    check(mapped.every(file => file.source.length <= 1024 * 1024)
      && mapped.reduce((sum, file) => sum + file.source.length, 0) <= 4 * 1024 * 1024, 'Upload exceeds the byte limit.');
    return exclusive(`${identity(experimentId).key}:${side}`, async () => {
      const sandbox = await ready(experimentId, side);
      await writable(experimentId, side);
      const pendingPath = join(identity(experimentId).directory, `${side}.upload-pending.json`);
      if (!await once(pendingPath, { requestedAt: timestamp() }))
        throw new DaytonaProviderError('uncertain', 'Another upload is already pending.');
      const directories = [...new Set(mapped.map(file => posix.dirname(file.destination)))];
      try {
        const result = await bounded(sandbox.process.executeCommand(`mkdir -p -- ${directories.map(quote).join(' ')}`, undefined, undefined, 10), 15);
        if (result.exitCode !== 0) throw new DaytonaProviderError('provider', 'Could not prepare upload directories.');
        await bounded(sandbox.fs.uploadFiles(mapped, 30), 35);
        await unlink(pendingPath);
      } catch { throw new DaytonaProviderError('uncertain', 'Upload completion could not be confirmed. Inspect or close this experiment.'); }
      return { files: mapped.length, bytes: mapped.reduce((sum, file) => sum + file.source.length, 0) };
    });
  }
  async function execute(experimentId: string, side: DaytonaSide, input: DaytonaCommand): Promise<DaytonaCommandResult> {
    check(typeof input.operationId === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId), 'A stable operation ID is required.');
    check(typeof input.command === 'string' && input.command.length > 0 && Buffer.byteLength(input.command) <= 16 * 1024
      && !input.command.includes('\0'), 'Invalid trusted command.');
    const seconds = input.timeoutSeconds ?? 30;
    check(Number.isInteger(seconds) && seconds >= 1 && seconds <= limits.operationSeconds, 'Command timeout exceeds its bound.');
    const cwd = input.cwd ?? workDirectory;
    check(typeof cwd === 'string' && !/[\x00-\x1f\x7f]/.test(cwd)
      && (cwd === workDirectory || (cwd.startsWith(`${workDirectory}/`) && posix.normalize(cwd) === cwd)), 'Command cwd escapes the app directory.');
    const requestHash = hash(JSON.stringify({ command: input.command, cwd, seconds }));
    return exclusive(`${identity(experimentId).key}:${side}`, async () => {
      const sandbox = await ready(experimentId, side);
      const directory = join(identity(experimentId).directory, 'commands');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${side}-${hash(input.operationId)}`);
      const prior = await load<{ requestHash: string }>(`${path}.intent.json`);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new DaytonaProviderError('invalid-input', 'Operation ID was already used for a different command.');
        const result = await load<DaytonaCommandResult>(`${path}.result.json`);
        if (result) return result;
        throw new DaytonaProviderError('uncertain', 'This command has an unknown outcome and will not be replayed.');
      }
      await writable(experimentId, side);
      const pendingPath = join(directory, `${side}.pending.json`);
      const first = await once(`${path}.intent.json`, { requestHash, requestedAt: timestamp() });
      if (!first) {
        throw new DaytonaProviderError('uncertain', 'This command has an unknown outcome and will not be replayed.');
      }
      if (!await once(pendingPath, { operationId: input.operationId }))
        throw new DaytonaProviderError('uncertain', 'Another command is already pending for this sandbox.');
      try {
        const result = await bounded(sandbox.process.executeCommand(input.command, cwd, undefined, seconds), seconds + 5);
        check(Number.isInteger(result.exitCode), 'Daytona did not return an exit status.');
        // SDK buffers output before this point. This bounds retained/displayed bytes, not SDK transport memory.
        const output = Buffer.from(result.result ?? '', 'utf8');
        const saved: DaytonaCommandResult = { operationId: input.operationId, exitCode: result.exitCode,
          output: new TextDecoder().decode(output.subarray(0, limits.maxOutputBytes), { stream: true }), outputBytes: output.length,
          outputTruncated: output.length > limits.maxOutputBytes, completedAt: timestamp() };
        await once(`${path}.result.json`, saved);
        await unlink(pendingPath);
        return saved;
      } catch { throw new DaytonaProviderError('uncertain', 'The command outcome could not be confirmed. Inspect the app or close this experiment; do not replay it.'); }
    });
  }
  function portCheck(port: number) { check(Number.isInteger(port) && port >= 1024 && port <= 65535
    && ![22222, 2280, 33333].includes(port), 'Invalid application preview port.'); }
  function secureUrl(value: string) { const url = new URL(value);
    check(url.protocol === 'https:' && !url.username && !url.password, 'Daytona returned an invalid preview URL.'); return url.toString(); }
  async function preview(experimentId: string, side: DaytonaSide, port: number) {
    portCheck(port); const sandbox = await ready(experimentId, side);
    const result = await bounded(sandbox.getPreviewLink(port), 30);
    check(typeof result.token === 'string' && result.token.length > 0, 'Private preview token missing.');
    // Never serialize these headers to a browser, run export, or log.
    return { url: secureUrl(result.url), headers: { 'x-daytona-preview-token': result.token,
      'x-daytona-skip-preview-warning': 'true' } };
  }
  async function signedPreview(experimentId: string, side: DaytonaSide, port: number, expiresInSeconds = 3600) {
    portCheck(port); check(Number.isInteger(expiresInSeconds) && expiresInSeconds >= 1 && expiresInSeconds <= 3600, 'Invalid preview expiry.');
    const sandbox = await ready(experimentId, side);
    const result = await bounded(sandbox.getSignedPreviewUrl(port, expiresInSeconds), 30);
    // This bearer URL is deliberately usable only by the authorized browser. Do not persist/export it.
    return { url: secureUrl(result.url), expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
  }
  async function cleanupPair(experimentId: string) {
    const info = identity(experimentId); await localIntent(experimentId);
    return exclusive('lifecycle', async () => {
      if (sides.some(side => inFlight.has(`${info.key}:${side}`))) throw new DaytonaProviderError('busy', 'Wait for the accepted sandbox operation before cleanup.');
      await once(join(info.directory, 'closing.json'), { requestedAt: timestamp() });
      const results: DaytonaCleanupSide[] = [];
      for (const side of sides) {
        const result: DaytonaCleanupSide = { side, name: info.name(side), id: null, state: 'uncertain', stoppedVerified: false, deletedVerified: false };
        try {
          const prior = await load<DaytonaCleanupSide>(join(info.directory, `${side}.deleted.json`));
          if (prior) { results.push(prior); continue; }
          // Cleanup must still remove our own accidentally misconfigured sandbox.
          // Identity/labels remain mandatory; privacy/resource checks do not block deletion.
          let sandbox = await lookup(experimentId, side, false); result.id = sandbox?.id ?? null;
          const attempted = await load(join(info.directory, `${side}.requested.json`));
          const created = await load<Created>(join(info.directory, `${side}.created.json`));
          if (!sandbox && attempted && !created) { results.push(result); continue; }
          if (sandbox) {
            if (sandbox.state !== 'stopped' && sandbox.state !== 'destroyed') {
              try { await bounded(sandbox.stop(limits.cleanupSeconds), limits.cleanupSeconds + 5); } catch { /* verify actual state next */ }
              sandbox = await lookup(experimentId, side, false);
            }
            result.stoppedVerified = !sandbox || sandbox.state === 'stopped' || sandbox.state === 'destroyed';
            if (sandbox && sandbox.state !== 'destroyed') {
              try { await bounded(sandbox.delete(limits.cleanupSeconds, true), limits.cleanupSeconds + 5); } catch { /* verify actual state next */ }
            }
            sandbox = await lookup(experimentId, side, false);
            if (sandbox && sandbox.state !== 'destroyed') { results.push(result); continue; }
          }
          result.state = attempted || created || result.id ? 'deleted' : 'never-created'; result.deletedVerified = true; result.stoppedVerified = true;
          await once(join(info.directory, `${side}.deleted.json`), result);
        } catch { /* Keep uncertainty and ownership conflicts visible; never delete a mismatched sandbox. */ }
        results.push(result);
      }
      const complete = results.every(result => result.deletedVerified);
      if (complete) {
        await once(join(info.directory, 'closed.json'), { closedAt: timestamp() });
        const active = await load<{ key: string }>(join(options.stateDirectory, 'active-pair.json'));
        if (active?.key === info.key) await unlink(join(options.stateDirectory, 'active-pair.json'));
      }
      return { experimentId, complete, sides: results, observedAt: timestamp() };
    });
  }
  return { ensurePair, inspectPair, uploadFiles, execute, preview, signedPreview, cleanupPair, workDirectory,
    /** Local pending count is diagnostic only; zero does not prove remote cleanup. */
    pendingOperations: () => pendingRemote.size };
}
export type DaytonaProvider = ReturnType<typeof createDaytonaProvider>;
