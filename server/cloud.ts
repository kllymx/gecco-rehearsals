import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CloudAction, CloudObservation, CloudSide, CloudSnapshot, CloudStatus } from '../shared/cloud.js';
import type { TwinCreateInput } from '../shared/twin.js';
import type { DaytonaProvider } from './daytona-provider.js';
import { validateTwinCreate } from './twins.js';

export class CloudApiError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}
const sides = ['left', 'right'] as const;
const journey = ['read-both', 'deploy', 'read-both', 'write-new', 'read-both', 'rollback', 'read-both'] as const;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const iso = () => new Date().toISOString();
const safeId = (id: string) => /^[0-9a-f-]{36}$/.test(id);
const sourceFile = (release: string) => `engine/specimen/${release}.ts`;
const done = (state: CloudSnapshot) => state.status === 'closed';

interface AppState {
  release: string; instanceId: string; pid: number; startedAt: string;
  releaseEntryPoint?: string; releaseSelection?: string;
  database: { id: string; kind: string; postgresVersion?: string };
  observation?: CloudObservation; revision: number;
}
interface AppResult {
  snapshot: AppState; trace: unknown[];
  outcome: 'passed' | 'failed' | 'inconclusive';
  error?: { name?: string; message?: string; code?: string };
}
interface Entry {
  state: CloudSnapshot;
  adminToken: string;
  sessionId: string;
  newSessionId: string;
  writeMarker: string;
  closeRequested: boolean;
  pauseRequested: boolean;
  job?: Promise<void>;
  cleanupJob?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  refresh?: Promise<void>;
  refreshedAt: number;
  endpoints: Partial<Record<CloudSide, { url: string; headers: Record<string, string> }>>;
}
export interface CloudManager {
  status(): Promise<CloudStatus>;
  create(input: unknown): Promise<CloudSnapshot>;
  snapshot(id: string): Promise<CloudSnapshot>;
  control(id: string, input: unknown): Promise<CloudSnapshot>;
  close(id: string): Promise<CloudSnapshot>;
  closeAll(): Promise<void>;
}
export interface CloudOptions {
  provider?: DaytonaProvider;
  stateDirectory: string;
  sourceRef: string;
  sourceRefs?: { base: string; breaking: string; compatible: string };
  repository?: string;
  fetch?: typeof fetch;
  dwellMs?: number;
  maxLifetimeMs?: number;
  /** Tests can replace native-image commands with equivalent observable fixtures. */
  bootstrapCommand?: string;
}

// Executed in the explicitly selected node:22-bookworm image as root. PostgreSQL
// and the application subsequently run as unprivileged users inside that sandbox.
export const NATIVE_BOOTSTRAP = `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends postgresql curl ca-certificates git >/tmp/gecco-install.log 2>&1
rm -rf /var/lib/apt/lists/*
pgver=$(ls /usr/lib/postgresql | sort -V | tail -1)
install -d -o postgres -g postgres /home/daytona/gecco/postgres /home/daytona/gecco/pgsocket
runuser -u postgres -- /usr/lib/postgresql/$pgver/bin/initdb -D /home/daytona/gecco/postgres --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale >/tmp/gecco-initdb.log
runuser -u postgres -- /usr/lib/postgresql/$pgver/bin/pg_ctl -D /home/daytona/gecco/postgres -l /home/daytona/gecco/postgres/server.log -o '-h 127.0.0.1 -p 54329 -k /home/daytona/gecco/pgsocket' -w start
runuser -u postgres -- /usr/lib/postgresql/$pgver/bin/createdb -h 127.0.0.1 -p 54329 gecco
node --version
/usr/lib/postgresql/$pgver/bin/postgres --version`;

export function createCloudManager(options: CloudOptions): CloudManager {
  const repository = options.repository ?? 'https://github.com/kllymx/gecco-rehearsals';
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Use a trusted public GitHub repository.');
  const configured = !!options.provider && /^[0-9a-f]{40}$/.test(options.sourceRef)
    && (!options.sourceRefs || Object.values(options.sourceRefs).every(ref => /^[0-9a-f]{40}$/.test(ref)));
  const provider = options.provider;
  const entrypoint = (release: string) => options.sourceRefs ? 'apps/fieldnotes/release.ts' : sourceFile(release);
  const requestFetch = options.fetch ?? fetch;
  const entries = new Map<string, Entry>();
  let activeId: string | undefined;
  let shuttingDown = false;
  const present = (entry: Entry) => structuredClone(entry.state);
  const diskPath = (id: string) => join(options.stateDirectory, `${id}.json`);
  async function atomic(path: string, data: unknown) {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, path);
  }
  async function persist(entry: Entry) {
    const state = present(entry);
    // Signed app URLs and private preview headers never enter exported or durable evidence.
    for (const side of sides) { delete state.apps[side].previewUrl; delete state.apps[side].previewExpiresAt; }
    await atomic(diskPath(state.id), { state, adminToken: entry.adminToken, sessionId: entry.sessionId,
      newSessionId: entry.newSessionId, writeMarker: entry.writeMarker });
  }
  function event(entry: Entry, title: string, detail: string, outcome?: AppResult['outcome'], evidence?: unknown) {
    entry.state.events.push({ id: randomUUID(), at: iso(), title, detail, outcome, evidence });
    entry.state.events = entry.state.events.slice(-60);
    entry.state.revision++;
  }
  async function progress(entry: Entry, stage: string, detail: string) {
    checkOpen(entry);
    entry.state.progress = { stage, detail };
    event(entry, stage, detail);
    await persist(entry);
  }
  function checkOpen(entry: Entry) {
    if (entry.closeRequested || Date.now() >= Date.parse(entry.state.expiresAt)) throw new CloudApiError(410, 'This sandbox pair is closing or expired.');
  }
  async function endpoint(entry: Entry, side: CloudSide) {
    return entry.endpoints[side] ??= await provider!.preview(entry.state.id, side, 4000);
  }
  async function admin<T>(entry: Entry, side: CloudSide, path: string, body?: unknown): Promise<T> {
    checkOpen(entry);
    const target = await endpoint(entry, side);
    const response = await requestFetch(new URL(path, target.url), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(25_000),
      headers: { ...target.headers, Authorization: `Bearer ${entry.adminToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 1_000_000) { await reader.cancel(); throw new CloudApiError(502, 'The application response exceeded its limit.'); }
      chunks.push(next.value);
    }
    if (!response.ok) throw new CloudApiError(502, `The ${side === 'left' ? 'previous' : 'proposed'} app did not accept ${path} (HTTP ${response.status}).`);
    let result: unknown;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CloudApiError(502, 'The running application returned an invalid response.'); }
    if (body !== undefined && path !== '/admin/read' && path !== '/admin/note') {
      if (!result || typeof result !== 'object' || !('outcome' in result) || result.outcome !== 'passed') {
        event(entry, 'Application operation did not complete', `${path} on the ${side} app returned no successful execution result.`, 'inconclusive', result);
        throw new CloudApiError(502, `The ${side} app could not complete ${path}. The rehearsal stopped without advancing.`);
      }
    }
    return result as T;
  }
  function observe(entry: Entry, side: CloudSide, state: AppState) {
    if (!state || typeof state.instanceId !== 'string' || !state.database?.id || !state.release)
      throw new CloudApiError(502, 'The application did not return its process and database identity.');
    const observation = state.observation ? { ...state.observation,
      at: String(state.observation.at ?? state.observation.observedAt ?? ''),
      error: state.observation.error && typeof state.observation.error === 'object'
        ? String((state.observation.error as { message?: string }).message ?? 'Application read failed.') : state.observation.error } : undefined;
    Object.assign(entry.state.apps[side], { state: 'running', release: state.release, entrypoint: state.releaseEntryPoint ?? entrypoint(state.release),
      instanceId: state.instanceId, databaseId: state.database.id, databaseKind: state.database.kind,
      postgresVersion: state.database.postgresVersion, observation });
  }
  async function refresh(entry: Entry) {
    if (entry.refresh) return entry.refresh;
    entry.refresh = (async () => {
      const states = await Promise.all(sides.map(side => admin<AppState>(entry, side, '/admin/state')));
      sides.forEach((side, i) => observe(entry, side, states[i]));
      entry.refreshedAt = Date.now();
    })().finally(() => { entry.refresh = undefined; });
    return entry.refresh;
  }
  async function runCommand(entry: Entry, side: CloudSide, command: string, timeoutSeconds = 120) {
    checkOpen(entry);
    const result = await provider!.execute(entry.state.id, side, { operationId: randomUUID(), command, timeoutSeconds });
    if (result.exitCode !== 0) {
      event(entry, `${side === 'left' ? 'Previous' : 'Proposed'} sandbox command failed`, 'The process returned a nonzero exit code.', 'inconclusive', result);
      throw new CloudApiError(502, `The ${side} sandbox setup failed (exit ${result.exitCode}). See execution evidence.`);
    }
    return result;
  }
  async function bootApp(entry: Entry, side: CloudSide, release: string, restart = false) {
    const cwd = provider!.workDirectory;
    const previousInstance = entry.state.apps[side].instanceId;
    const sourceRef = restart && options.sourceRefs ? options.sourceRefs.base : entry.state.apps[side].sourceRef;
    const env = `${options.sourceRefs ? '' : `GECCO_RELEASE=${release}\n`}GECCO_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/gecco\nGECCO_ADMIN_TOKEN=${entry.adminToken}\nGECCO_STATE_FILE=${cwd}/runtime/state.json\nPORT=3000\nGECCO_ADMIN_PORT=4000\n`;
    await provider!.uploadFiles(entry.state.id, side, [{ path: 'runtime/app.env', bytes: Buffer.from(env) }]);
    // The credential file is not printed, committed, or passed as a command argument.
    const command = `set -eu
cd ${quote(cwd)}
${restart ? `if [ -f runtime/app.pid ]; then pid=$(cat runtime/app.pid); kill -TERM -- -"$pid" 2>/dev/null || true; for attempt in $(seq 1 30); do if ! kill -0 "$pid" 2>/dev/null; then break; fi; sleep 0.1; done; if kill -0 "$pid" 2>/dev/null; then kill -KILL -- -"$pid" 2>/dev/null || true; fi; fi` : ''}
${restart && options.sourceRefs ? `runuser -u node -- git -C ${quote(cwd + '/repo')} checkout --detach ${quote(sourceRef)}\ntest "$(runuser -u node -- git -C ${quote(cwd + '/repo')} rev-parse HEAD)" = ${quote(sourceRef)}` : ''}
chmod 600 runtime/app.env
chown -R node:node runtime
runuser -u node -- sh -c 'cd ${cwd}; set -a; . ./runtime/app.env; set +a; cd repo/apps/fieldnotes; nohup setsid ./node_modules/.bin/tsx server.ts >${cwd}/runtime/app.log 2>&1 </dev/null & echo $! >${cwd}/runtime/app.pid'
for attempt in $(seq 1 40); do if curl -fsS http://127.0.0.1:3000/health >/dev/null; then printf 'Fieldnotes HTTP health passed\\n'; exit 0; fi; sleep 0.5; done
tail -c 4000 runtime/app.log
exit 1`;
    const result = await runCommand(entry, side, command, 40);
    event(entry, `${side === 'left' ? 'Previous' : 'Proposed'} app ${restart ? 'restarted' : 'started'}`, `${release} is serving HTTP on port 3000.`, undefined, result);
    entry.state.apps[side].release = release;
    entry.state.apps[side].entrypoint = entrypoint(release);
    entry.state.apps[side].sourceRef = sourceRef;
    await refreshSide(entry, side);
    if (entry.state.apps[side].release !== release || (restart && previousInstance === entry.state.apps[side].instanceId))
      throw new CloudApiError(502, 'The requested code version did not start in a new application process.');
  }
  async function refreshSide(entry: Entry, side: CloudSide) { observe(entry, side, await admin<AppState>(entry, side, '/admin/state')); }
  async function autoMode(entry: Entry, enabled: boolean) {
    await Promise.all(sides.map(side => admin(entry, side, '/admin/config', { autonomous: enabled })));
  }
  async function provision(entry: Entry) {
    try {
      await progress(entry, 'Creating two Daytona sandboxes', 'Allocating separate Linux filesystems, processes and network endpoints.');
      const pair = await provider!.ensurePair(entry.state.id);
      for (const side of sides) Object.assign(entry.state.apps[side], { sandboxId: pair[side].id ?? undefined, state: pair[side].state });
      await progress(entry, 'Installing native runtimes', 'Installing PostgreSQL inside each Node.js sandbox.');
      for (const side of sides) {
        await provider!.uploadFiles(entry.state.id, side, [{ path: 'runtime/bootstrap.sh', bytes: Buffer.from(options.bootstrapCommand ?? NATIVE_BOOTSTRAP) }]);
        const result = await runCommand(entry, side, 'sh runtime/bootstrap.sh', 300);
        event(entry, `${side === 'left' ? 'Previous' : 'Proposed'} database started`, 'Native PostgreSQL is running inside this sandbox.', undefined, result);
      }
      await progress(entry, 'Cloning the public application', 'Checking out the exact published source revision in both sandboxes.');
      for (const side of sides) {
        const sourceRef = entry.state.apps[side].sourceRef;
        const result = await runCommand(entry, side,
          `set -eu\ngit clone --no-checkout ${quote(`${repository}.git`)} repo\ncd repo\ngit checkout --detach ${quote(sourceRef)}\ntest "$(git rev-parse HEAD)" = ${quote(sourceRef)}\ncd apps/fieldnotes\nnpm ci --no-audit --no-fund\nprintf 'Checked out source: '\ngit rev-parse HEAD\nchown -R node:node ${quote(provider!.workDirectory + '/repo')}`, 180);
        event(entry, `${side === 'left' ? 'Previous' : 'Proposed'} source installed`, `${sourceRef.slice(0, 12)} · npm ci completed.`, undefined, result);
      }
      await progress(entry, 'Starting the previous and proposed apps', 'Each application serves its own interface and API directly from its sandbox.');
      await bootApp(entry, 'left', 'v1');
      await bootApp(entry, 'right', `v2-${entry.state.variant}`);
      await progress(entry, 'Preparing identical starting data', 'Creating the same session in two separate native PostgreSQL databases.');
      const seed = { label: entry.state.label, sessionId: entry.sessionId, writeMarker: entry.writeMarker,
        note: `A release note from ${entry.state.label}. Edit me in either running app.` };
      await admin(entry, 'left', '/admin/initialize', seed);
      await admin(entry, 'right', '/admin/initialize', seed);
      // The proposed instance starts with its own upgraded database for the isolated control.
      await admin(entry, 'right', '/admin/migrate', { direction: 'up', variant: entry.state.variant });
      await refresh(entry);
      for (const side of sides) {
        const preview = await provider!.signedPreview(entry.state.id, side, 3000, 3600);
        Object.assign(entry.state.apps[side], { previewUrl: preview.url, previewExpiresAt: preview.expiresAt });
      }
      entry.state.busy = false;
      entry.state.status = 'ready';
      await progress(entry, 'Both applications are live', 'The autonomous rehearsal will now compare behavior, deploy the change and test rollback.');
      await persist(entry);
      startAutonomy(entry);
    } catch (error) { await fail(entry, error); }
  }
  function clearObservations(entry: Entry) { for (const side of sides) delete entry.state.apps[side].observation; }
  async function perform(entry: Entry, action: Exclude<CloudAction, 'play' | 'pause'>) {
    checkOpen(entry);
    if (action === 'read-both') {
      const results = await Promise.all(sides.map(side => admin<AppResult>(entry, side, '/admin/read', {})));
      sides.forEach((side, i) => observe(entry, side, results[i].snapshot));
      const outcome = results.some(r => r.outcome === 'inconclusive') ? 'inconclusive' : results.some(r => r.outcome === 'failed') ? 'failed' : 'passed';
      event(entry, entry.state.phase === 'baseline' ? 'Both versions tested independently' : entry.state.phase === 'rollout' ? 'Old and new code tested against release data' : 'Previous code tested after rollback',
        outcome === 'passed' ? 'Both running applications read the session successfully.' : outcome === 'failed'
          ? 'An application could not read the session. The failure came from the executing code and PostgreSQL.' : 'The check did not produce a reliable compatibility verdict.', outcome,
        { left: results[0], right: results[1] });
      if (outcome === 'inconclusive') throw new CloudApiError(502, 'An application check was inconclusive; the rehearsal stopped.');
    } else if (action === 'deploy') {
      if (entry.state.phase !== 'baseline') throw new CloudApiError(409, 'The change has already been deployed.');
      clearObservations(entry);
      const migrated = await admin<AppResult>(entry, 'left', '/admin/migrate', { direction: 'up', variant: entry.state.variant });
      const left = await endpoint(entry, 'left');
      // Only the right application receives a limited fixed-statement gateway credential.
      // No cloud API key is ever present in either app or sandbox.
      await admin(entry, 'right', '/admin/config', { database: { kind: 'gateway', url: left.url,
        token: entry.adminToken, previewToken: left.headers['x-daytona-preview-token'], databaseId: entry.state.apps.left.databaseId } });
      entry.state.phase = 'rollout';
      event(entry, 'Release deployed into the shared database', 'The proposed app now talks to the previous sandbox’s PostgreSQL. Old instances must keep working against the migrated data.', migrated.outcome, { trace: migrated.trace });
    } else if (action === 'write-new') {
      if (entry.state.phase !== 'rollout') throw new CloudApiError(409, 'Deploy before creating a session with the proposed app.');
      clearObservations(entry);
      const written = await admin<AppResult>(entry, 'right', '/admin/write-session', { session: { id: entry.newSessionId,
        userId: entry.state.label, role: 'member', writeMarker: `${entry.writeMarker}-new` } });
      await Promise.all(sides.map(side => admin(entry, side, '/admin/config', { selectedSessionId: entry.newSessionId })));
      event(entry, 'The new app created a real session', 'Both apps now try the same session written by the new release. This data will remain when the code rolls back.', written.outcome, { trace: written.trace });
    } else {
      if (entry.state.phase !== 'rollout') throw new CloudApiError(409, 'Deploy before rolling back.');
      clearObservations(entry);
      const migration = await admin<AppResult>(entry, 'left', '/admin/migrate', { direction: 'down', variant: entry.state.variant });
      await bootApp(entry, 'right', 'v1', true);
      entry.state.phase = 'rollback';
      event(entry, 'Previous code restarted; new data retained', 'The proposed sandbox now runs a new v1 process. PostgreSQL still holds the sessions created by the release.', migration.outcome, { trace: migration.trace });
    }
    await persist(entry);
  }
  function schedule(entry: Entry) {
    entry.timer = setTimeout(() => { entry.timer = undefined; entry.job = step(entry); }, options.dwellMs ?? 4500);
    entry.timer.unref();
  }
  function startAutonomy(entry: Entry) {
    if (entry.closeRequested) return;
    entry.pauseRequested = false;
    entry.state.status = 'running';
    schedule(entry);
  }
  async function step(entry: Entry) {
    if (entry.closeRequested || entry.state.status !== 'running') return;
    entry.state.busy = true;
    const action = journey[entry.state.automation.step];
    try {
      await autoMode(entry, true);
      entry.state.automation.action = action;
      await perform(entry, action);
      entry.state.automation.step++;
      entry.state.automation.action = undefined;
      if (entry.state.automation.step >= journey.length) {
        entry.state.status = 'completed';
        entry.state.progress = { stage: 'Rehearsal complete', detail: 'Explore either live app, inspect the evidence, or close the sandbox pair.' };
        await autoMode(entry, false);
      } else if (entry.pauseRequested) { entry.state.status = 'paused'; await autoMode(entry, false); }
      else schedule(entry);
      await persist(entry);
    } catch (error) { await fail(entry, error); }
    finally { entry.state.busy = false; }
  }
  async function fail(entry: Entry, error: unknown) {
    if (entry.closeRequested) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.state.status = 'failed'; entry.state.busy = false;
    entry.state.error = error instanceof CloudApiError ? error.message : 'The cloud operation could not be confirmed. Inspect the execution evidence and cleanup status.';
    entry.state.progress = { stage: 'Rehearsal stopped', detail: entry.state.error };
    event(entry, 'Execution stopped', entry.state.error, 'inconclusive');
    // Do not leave failed allocation/setup consuming resources. This begins after
    // the current accepted provider call has returned; unknown outcomes remain visible.
    await persist(entry);
    if (!entry.state.apps.left.previewUrl || !entry.state.apps.right.previewUrl) {
      void requestClose(entry);
    } else {
      try { await autoMode(entry, false); } catch { /* Failure remains explicit; TTL still applies. */ }
    }
  }
  async function requestClose(entry: Entry) {
    if (entry.cleanupJob) return entry.cleanupJob;
    if (done(entry.state)) return;
    entry.closeRequested = true; entry.state.status = 'closing';
    if (entry.timer) clearTimeout(entry.timer);
    entry.state.progress = { stage: 'Closing both sandboxes', detail: 'Waiting for accepted work, then verifying the remote sandboxes are deleted.' };
    entry.cleanupJob = (async () => {
      await persist(entry);
      await entry.job?.catch(() => {});
      try {
        const cleanup = await provider!.cleanupPair(entry.state.id);
        entry.state.cleanup = cleanup;
        entry.state.busy = false;
        entry.state.status = cleanup.complete ? 'closed' : 'failed';
        for (const side of sides) {
          delete entry.state.apps[side].previewUrl;
          entry.state.apps[side].state = cleanup.sides.find(s => s.side === side)?.state ?? 'uncertain';
        }
        entry.state.progress = { stage: cleanup.complete ? 'Both sandboxes deleted' : 'Cleanup needs attention',
          detail: cleanup.complete ? 'Daytona confirmed the sandbox pair is no longer running.' : 'Remote cleanup is not yet confirmed. The pair is retained for reconciliation.' };
        if (cleanup.complete && activeId === entry.state.id) { activeId = undefined; await atomic(join(options.stateDirectory, 'active.json'), { id: null }); }
      } catch {
        entry.state.status = 'failed'; entry.state.busy = false;
        entry.state.progress = { stage: 'Cleanup needs attention', detail: 'Daytona cleanup could not be confirmed. The saved sandbox identities are retained.' };
      }
      await persist(entry);
    })().finally(() => { entry.cleanupJob = undefined; });
    return entry.cleanupJob;
  }
  const initialized = (async () => {
    try {
      const saved = JSON.parse(await readFile(join(options.stateDirectory, 'active.json'), 'utf8')) as { id?: string };
      if (!saved.id || !safeId(saved.id)) return;
      const stored = JSON.parse(await readFile(diskPath(saved.id), 'utf8')) as Pick<Entry, 'state' | 'adminToken' | 'sessionId' | 'newSessionId' | 'writeMarker'>;
      const entry: Entry = { ...stored, closeRequested: false, pauseRequested: true, endpoints: {}, refreshedAt: 0 };
      entries.set(saved.id, entry); activeId = saved.id;
      entry.state.error = 'The demo coordinator restarted. The previous sandbox pair is being reconciled and closed.';
      if (provider) void requestClose(entry);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  })();
  const reaper = setInterval(() => {
    for (const entry of entries.values()) if (!done(entry.state) && Date.now() >= Date.parse(entry.state.expiresAt)) void requestClose(entry);
  }, 10_000); reaper.unref();
  async function get(id: string) {
    await initialized;
    const entry = safeId(id) ? entries.get(id) : undefined;
    if (!entry) throw new CloudApiError(404, 'Sandbox pair not found.');
    return entry;
  }
  return {
    async status() {
      await initialized;
      return { configured, activeId, repository, sourceRef: options.sourceRef,
        ...(!provider ? { reason: 'Connect the Daytona account to start real cloud sandboxes.' } : !configured ? { reason: 'Publish and pin the application source revision before starting.' } : {}) };
    },
    async create(input) {
      await initialized;
      if (!configured || shuttingDown) throw new CloudApiError(503, 'Daytona is not configured with a published application revision.');
      if (activeId) throw new CloudApiError(409, 'Close the existing sandbox pair before starting another.');
      const value: TwinCreateInput = validateTwinCreate(input);
      const id = randomUUID();
      const entry: Entry = { state: {
        id, provider: 'daytona', status: 'provisioning', variant: value.variant, label: value.label, phase: 'baseline',
        createdAt: iso(), expiresAt: new Date(Date.now() + (options.maxLifetimeMs ?? 3600_000)).toISOString(), revision: 0,
        progress: { stage: 'Starting a cloud rehearsal', detail: 'Preparing two independent Daytona sandboxes.' },
        repository, apps: { left: { side: 'left', state: 'queued', release: 'v1', entrypoint: entrypoint('v1'), sourceRef: options.sourceRefs?.base ?? options.sourceRef },
          right: { side: 'right', state: 'queued', release: `v2-${value.variant}`, entrypoint: entrypoint(`v2-${value.variant}`), sourceRef: options.sourceRefs?.[value.variant] ?? options.sourceRef } },
        events: [], automation: { step: 0, total: journey.length }, busy: true,
      }, adminToken: randomBytes(32).toString('hex'), sessionId: `session-${randomUUID()}`, newSessionId: `new-${randomUUID()}`,
      writeMarker: randomUUID(), closeRequested: false, pauseRequested: false, endpoints: {}, refreshedAt: 0 };
      activeId = id; entries.set(id, entry);
      await persist(entry); await atomic(join(options.stateDirectory, 'active.json'), { id });
      entry.job = provision(entry);
      return present(entry);
    },
    async snapshot(id) {
      const entry = await get(id);
      if (!entry.closeRequested && !entry.state.busy && ['ready', 'running', 'paused', 'completed'].includes(entry.state.status)
        && Date.now() - entry.refreshedAt > 2000) {
        try { await refresh(entry); }
        catch { entry.state.progress = { stage: 'Application connection interrupted', detail: 'Live app state is temporarily unavailable. No new check result has been inferred.' }; }
      }
      return present(entry);
    },
    async control(id, input) {
      const entry = await get(id);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('action' in input)
        || !['play', 'pause', 'read-both', 'deploy', 'write-new', 'rollback'].includes(String(input.action))) throw new CloudApiError(400, 'Choose one supported rehearsal control.');
      checkOpen(entry);
      const action = input.action as CloudAction;
      if (action === 'pause' && entry.state.status === 'running') {
        entry.pauseRequested = true;
        if (!entry.state.busy) { if (entry.timer) clearTimeout(entry.timer); entry.state.status = 'paused'; await autoMode(entry, false); }
        await persist(entry); return present(entry);
      }
      if (entry.state.busy || entry.state.status === 'provisioning' || entry.state.status === 'running') throw new CloudApiError(409, 'Pause the rehearsal and let the current operation finish first.');
      if (!['ready', 'paused', 'completed'].includes(entry.state.status)) throw new CloudApiError(409, 'This rehearsal cannot accept more commands.');
      if (action === 'play') {
        if (entry.state.automation.step >= journey.length) throw new CloudApiError(409, 'The journey is complete. Start a new sandbox pair to rehearse again.');
        startAutonomy(entry); await persist(entry); return present(entry);
      }
      if (action === 'pause') return present(entry);
      entry.state.busy = true;
      entry.job = (async () => {
        try {
          await autoMode(entry, true); await perform(entry, action);
          // After a manual structural operation, skip the corresponding automated step.
          if (action !== 'read-both') entry.state.automation.step = journey.indexOf(action) + 1;
          entry.state.status = 'paused'; await autoMode(entry, false); await persist(entry);
        } catch (error) { await fail(entry, error); }
        finally { entry.state.busy = false; }
      })();
      return present(entry);
    },
    async close(id) {
      const entry = await get(id);
      // A user may request reconciliation as soon as an uncertain result is
      // visible, while that result's final disk write is still finishing.
      if (entry.cleanupJob && entry.state.status === 'failed') void entry.cleanupJob.then(() => requestClose(entry));
      else void requestClose(entry);
      return present(entry);
    },
    async closeAll() {
      shuttingDown = true; clearInterval(reaper); await initialized;
      // A cleanup may have set status=closed while its final durable write is
      // still pending. Wait for that job too before shutdown or test teardown.
      await Promise.all([...entries.values()].map(requestClose));
    },
  };
}
