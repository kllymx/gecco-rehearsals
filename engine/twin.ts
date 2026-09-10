import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { Variant } from '../shared/contracts.js';
import type { TwinAction, TwinCommand, TwinCreateInput, TwinDatabase, TwinEvent, TwinObservation, TwinSide, TwinSnapshot } from '../shared/twin.js';
import { getInputDigests } from './index.js';
import * as v1 from './specimen/v1.js';
import type { Session } from './specimen/types.js';

const fixtureSQL = readFileSync(new URL('./specimen/fixture.sql', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('./twin-app-worker.ts', import.meta.url), 'utf8');
const notesSQL = 'CREATE TABLE notes (user_id TEXT PRIMARY KEY, body TEXT NOT NULL)';
const initialNote = 'A note saved before the release.';
const migrations = Object.fromEntries((['breaking', 'compatible'] as const).map(variant => [variant, {
  up: readFileSync(new URL(`./specimen/${variant}-up.sql`, import.meta.url), 'utf8'),
  down: readFileSync(new URL(`./specimen/${variant}-down.sql`, import.meta.url), 'utf8'),
}])) as Record<Variant, { up: string; down: string }>;
const permittedActions: TwinAction[] = ['read-both', 'read-left', 'read-right', 'save-left', 'save-right', 'deploy', 'write-new', 'rollback'];
const scope = 'Two independent Node app processes execute the bundled session readers, writers and note actions. Each starts with its own real disposable PostgreSQL database in PGlite. Deploy routes both to the migrated left database; rollback keeps its writes and replaces the right process with v1. App SQL is brokered locally over IPC. Synthetic session data only; no external authentication, payment requests, arbitrary PR imports or production access.';

export class TwinError extends Error {
  constructor(message: string, public readonly statusCode = 400, public readonly code = 'invalid-command') {
    super(message); this.name = 'TwinError';
  }
}
export interface TwinSession {
  snapshot(): Promise<TwinSnapshot>;
  execute(command: TwinCommand): Promise<TwinSnapshot>;
  close(): Promise<void>;
}
type Sql = TwinEvent['sql'][number];
type WorkerReply = { session?: Session; note?: string };
type Operation = 'read' | 'save' | 'write';
type QueryRunner = Pick<PGlite, 'query' | 'exec'>;
class AppFailure extends Error {
  constructor(message: string, public readonly compatibility = false, public readonly code?: string) { super(message); }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
function errorText(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
  return `${code ? `PostgreSQL ${code}: ` : ''}${error instanceof Error ? error.message : String(error)}`;
}

class AppRuntime {
  readonly instanceId: string;
  private child: ChildProcess;
  private pending?: { id: string; event: TwinEvent; databaseId: string; resolve: (result: WorkerReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private ready: Promise<void>;
  private readyTimer: ReturnType<typeof setTimeout>;
  private exited: Promise<void>;
  private stopped = false;

  constructor(readonly release: 'v1' | 'v2', variant: Variant,
    private readonly query: (databaseId: string, query: string, parameters: unknown[] | undefined, event: TwinEvent) => Promise<Record<string, unknown>[]>) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.child = fork(fileURLToPath(new URL('./twin-app-worker.ts', import.meta.url)), [release, variant], {
      execPath: process.execPath, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: false, serialization: 'json',
    });
    this.instanceId = `app-${this.child.pid ?? 'unstarted'}-${randomUUID()}`;
    this.exited = new Promise(resolve => { this.child.once('close', resolve); });
    this.readyTimer = setTimeout(() => this.fail(new AppFailure('App startup exceeded its 10 second limit.')), 10_000);
    let outputBytes = 0;
    this.child.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64_000) this.fail(new AppFailure('App diagnostic output exceeded its limit.'));
    });
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', (code, signal) => {
      if (!this.stopped) this.fail(new AppFailure(`App process exited unexpectedly (${code ?? signal}).`));
    });
    this.child.on('message', message => { void this.receive(message); });
  }
  private send(message: unknown): void {
    if (!this.child.connected) { this.fail(new AppFailure('App IPC disconnected.')); return; }
    this.child.send(message as object, error => { if (error) this.fail(error); });
  }
  private fail(error: Error): void {
    clearTimeout(this.readyTimer);
    this.readyReject(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
    this.stopped = true;
    this.child.kill('SIGKILL');
  }
  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const data = message as Record<string, unknown>;
    if (data.type === 'ready') { clearTimeout(this.readyTimer); this.readyResolve(); return; }
    const pending = this.pending;
    if (!pending || data.operationId !== pending.id) return;
    if (data.type === 'query') {
      if (typeof data.query !== 'string' || data.query.length > 16_000 || (data.parameters !== undefined && !Array.isArray(data.parameters))) {
        this.fail(new AppFailure('Invalid trusted app query.')); return;
      }
      try {
        const rows = await this.query(pending.databaseId, data.query, data.parameters as unknown[] | undefined, pending.event);
        if (this.pending?.id === pending.id) this.send({ type: 'query-result', queryId: data.queryId, rows });
      } catch (error) {
        if (this.pending?.id === pending.id) this.send({ type: 'query-result', queryId: data.queryId, error: {
          message: error instanceof Error ? error.message : String(error),
          code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
        } });
      }
    } else if (data.type === 'result') {
      clearTimeout(pending.timer); this.pending = undefined;
      if (data.error) {
        const error = data.error as { message: string; compatibility: boolean; code?: string };
        pending.reject(new AppFailure(error.message, error.compatibility, error.code));
      } else pending.resolve(data.result as WorkerReply);
    }
  }
  async start(): Promise<void> { await this.ready; }
  async run(operation: Operation, expected: Session, databaseId: string, event: TwinEvent, note?: string): Promise<WorkerReply> {
    await this.ready;
    if (this.stopped || this.pending) throw new AppFailure('The app process is unavailable or busy.');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pending = { id, event, databaseId, resolve, reject,
        timer: setTimeout(() => this.fail(new AppFailure('App operation exceeded its 10 second limit.')), 10_000) };
      this.send({ type: 'run', operationId: id, operation, expected, note });
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.readyTimer);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new AppFailure('App closed.')); this.pending = undefined; }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
    const force = setTimeout(() => this.child.kill('SIGKILL'), 500);
    try { await this.exited; } finally { clearTimeout(force); }
  }
}

export async function createTwinSession(input: TwinCreateInput): Promise<TwinSession> {
  if (!input || !['breaking', 'compatible'].includes(input.variant) || typeof input.label !== 'string') throw new TwinError('Choose a bundled variant and a session label.');
  const label = input.label.trim();
  if (!label || [...label].length > 48 || /[\u0000-\u001f\u007f-\u009f]/.test(input.label)) throw new TwinError('Use 1 to 48 characters without control characters.');
  const variant = input.variant;
  const original: Session = { id: `twin-v1-${randomUUID()}`, userId: label, role: 'viewer', writeMarker: `twin-v1-write-${randomUUID()}` };
  const leftId = randomUUID(); const rightId = randomUUID();
  const createdAt = new Date().toISOString();
  const state: TwinSnapshot = {
    id: randomUUID(), revision: 0, variant, label, phase: 'baseline', createdAt, updatedAt: createdAt,
    sourceDigest: hash({ specimen: getInputDigests(variant).sourceDigest, appWorker: workerSource }),
    fixtureDigest: hash({ fixtureSQL, notesSQL, original, note: initialNote }),
    apps: {
      left: { instanceId: '', release: 'v1', databaseId: leftId, sessionId: original.id, stale: true },
      right: { instanceId: '', release: 'v2', databaseId: rightId, sessionId: original.id, stale: true },
    }, databases: [], events: [], allowedActions: [], scope, busy: false,
    automation: { status: 'idle', stepIndex: 0, totalSteps: 8 },
  };
  const databases = new Map<string, PGlite>();
  const runtimes: Partial<Record<TwinSide, AppRuntime>> = {};
  const allRuntimes = new Set<AppRuntime>();
  const expected = new Map<string, Session>([[original.id, original]]);
  const accepted = new Map<string, { command: string; snapshot: TwinSnapshot }>();
  let available = false; let closed = false; let written = false;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => { const result = queue.then(work); queue = result.catch(() => undefined); return result; };

  async function query(databaseId: string, query: string, parameters: unknown[] | undefined, event?: TwinEvent, runner?: QueryRunner) {
    const sql: Sql = { databaseId, query, ...(parameters ? { parameters: structuredClone(parameters) } : {}) };
    event?.sql.push(sql);
    try {
      const result = await (runner ?? databases.get(databaseId)!).query<Record<string, unknown>>(query, parameters);
      sql.rows = structuredClone(result.rows); return result.rows;
    } catch (error) { sql.error = errorText(error); throw error; }
  }
  async function exec(databaseId: string, sqlText: string, event: TwinEvent, runner?: QueryRunner) {
    const sql: Sql = { databaseId, query: sqlText }; event.sql.push(sql);
    try { sql.rows = (await (runner ?? databases.get(databaseId)!).exec(sqlText)).flatMap(result => result.rows as Record<string, unknown>[]); }
    catch (error) { sql.error = errorText(error); throw error; }
  }
  async function inspect(event?: TwinEvent) {
    const snapshots: TwinDatabase[] = [];
    for (const [id] of databases) {
      const columns = await query(id, "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions' ORDER BY ordinal_position", undefined, event);
      const rows = await query(id, 'SELECT * FROM sessions ORDER BY id', undefined, event);
      const notes = await query(id, 'SELECT body FROM notes WHERE user_id = $1', [label], event);
      snapshots.push({ id, columns: columns.map(column => String(column.column_name)), rows, note: String(notes[0]?.body ?? '') });
    }
    state.databases = snapshots;
  }
  async function startRuntime(side: TwinSide, release: 'v1' | 'v2') {
    const runtime = new AppRuntime(release, variant, query); allRuntimes.add(runtime);
    await runtime.start(); runtimes[side] = runtime;
    state.apps[side].instanceId = runtime.instanceId; state.apps[side].release = release;
  }
  const event = (action: TwinEvent['action'], id: string): TwinEvent => ({ id, action, phase: state.phase, at: new Date().toISOString(), title: '', explanation: '', outcome: 'inconclusive', durationMs: 0, observations: {}, sql: [] });
  function allowed(): TwinAction[] {
    if (!available || closed || state.events.length >= 100) return [];
    return ['read-both', 'read-left', 'read-right', 'save-left', 'save-right',
      ...(state.phase === 'baseline' ? ['deploy' as const] : state.phase === 'rollout' ? [...(!written ? ['write-new' as const] : []), 'rollback' as const] : [])];
  }
  function copy() { state.allowedActions = allowed(); return structuredClone(state); }
  function stale(databaseId?: string) {
    for (const side of ['left', 'right'] as const) if (!databaseId || state.apps[side].databaseId === databaseId) state.apps[side].stale = true;
  }
  async function observe(side: TwinSide, operation: 'read' | 'save', entry: TwinEvent, note?: string) {
    const app = state.apps[side];
    const observation: TwinObservation = { outcome: 'inconclusive', at: new Date().toISOString(), revision: state.revision + 1, sessionId: app.sessionId };
    try {
      const result = await runtimes[side]!.run(operation, expected.get(app.sessionId)!, app.databaseId, entry, note);
      Object.assign(observation, { outcome: 'passed', userId: result.session!.userId, role: result.session!.role, writeMarker: result.session!.writeMarker, note: result.note });
      if (operation === 'save') stale(app.databaseId);
    } catch (error) {
      observation.outcome = error instanceof AppFailure && error.compatibility ? 'failed' : 'inconclusive';
      observation.error = errorText(error);
    }
    app.observation = observation; app.stale = false; entry.observations[side] = observation;
  }
  async function releaseResources() {
    const appResults = await Promise.allSettled([...allRuntimes].map(runtime => runtime.close()));
    const dbResults = await Promise.allSettled([...databases.values()].map(db => db.closed ? Promise.resolve() : db.close()));
    const failure = [...appResults, ...dbResults].find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  const create = event('create', randomUUID()); const createStart = performance.now();
  try {
    for (const id of [leftId, rightId]) {
      const db = new PGlite(); databases.set(id, db); await db.waitReady;
      await query(id, 'SELECT version() AS postgres_version', undefined, create);
      await db.transaction(async transaction => {
        await exec(id, fixtureSQL, create, transaction);
        await v1.writeSession({ query: async (sql, parameters) => ({ rows: await query(id, sql, parameters, create, transaction) }) }, original);
        await exec(id, notesSQL, create, transaction);
        await query(id, 'INSERT INTO notes (user_id, body) VALUES ($1, $2)', [label, initialNote], create, transaction);
        if (id === rightId) await exec(id, migrations[variant].up, create, transaction);
      });
    }
    await startRuntime('left', 'v1'); await startRuntime('right', 'v2');
    await inspect(create); available = true;
    create.outcome = 'passed'; create.title = 'Two independent apps are ready';
    create.explanation = 'Both databases started with identical personalized sessions and notes. The left app runs v1 on its original schema; the right app runs v2 on its separately migrated database.';
  } catch (error) {
    create.title = 'Paired app setup is inconclusive'; create.explanation = errorText(error); available = false;
    await releaseResources().catch(() => undefined);
  }
  create.durationMs = performance.now() - createStart; state.events.push(create);

  return {
    snapshot: () => enqueue(async () => {
      if (closed) throw new TwinError('This paired session is closed.', 410, 'closed');
      if (available) await inspect(); return copy();
    }),
    execute: command => enqueue(async () => {
      if (closed) throw new TwinError('This paired session is closed.', 410, 'closed');
      const saving = command?.action === 'save-left' || command?.action === 'save-right';
      if (!command || typeof command.commandId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(command.commandId)
        || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || !permittedActions.includes(command.action)
        || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'action', 'note'].includes(key))
        || (saving ? typeof command.note !== 'string' || [...command.note].length > 280 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(command.note) : command.note !== undefined)) {
        throw new TwinError('Supply a valid action, command ID and revision; save actions require a note of at most 280 characters.');
      }
      const identity = canonical(command); const prior = accepted.get(command.commandId);
      if (prior) {
        if (prior.command !== identity) throw new TwinError('This command ID already identifies a different request.', 409);
        return structuredClone(prior.snapshot);
      }
      if (command.expectedRevision !== state.revision) throw new TwinError(`Expected revision ${state.revision}, received ${command.expectedRevision}.`, 409, 'revision-conflict');
      if (state.events.length >= 100) throw new TwinError('The session has reached its 100-event limit.', 409, 'event-limit');
      if (!allowed().includes(command.action)) throw new TwinError(`Action ${command.action} is unavailable in phase ${state.phase}.`, 409, 'invalid-phase');
      const entry = event(command.action, command.commandId); const start = performance.now();
      try {
        if (command.action === 'read-both') {
          entry.title = 'Read through both app processes';
          await Promise.all([observe('left', 'read', entry), observe('right', 'read', entry)]);
        } else if (['read-left', 'read-right', 'save-left', 'save-right'].includes(command.action)) {
          const side: TwinSide = command.action.endsWith('left') ? 'left' : 'right';
          entry.title = `${saving ? 'Save note' : 'Read session'} through the ${side} app`;
          await observe(side, saving ? 'save' : 'read', entry, command.note);
        } else if (command.action === 'deploy') {
          entry.title = 'Deploy both apps onto one database';
          await databases.get(leftId)!.transaction(transaction => exec(leftId, migrations[variant].up, entry, transaction));
          state.apps.right.databaseId = leftId; state.phase = 'rollout'; stale();
          entry.explanation = 'The left database was migrated in place. Both independent app processes now use that same database; the separate right baseline database remains untouched and inactive.';
        } else if (command.action === 'write-new') {
          entry.title = 'The new app writes a shared session';
          const fresh: Session = { id: `twin-v2-${randomUUID()}`, userId: label, role: 'editor', writeMarker: `twin-v2-write-${randomUUID()}` };
          await runtimes.right!.run('write', fresh, leftId, entry);
          expected.set(fresh.id, fresh); state.apps.left.sessionId = state.apps.right.sessionId = fresh.id; written = true; stale();
          entry.explanation = `The right app stored ${label}'s new session. Both apps now select that exact row and marker for subsequent reads and rollback.`;
        } else if (command.action === 'rollback') {
          entry.title = 'Roll back code without discarding shared data';
          await databases.get(leftId)!.transaction(transaction => exec(leftId, migrations[variant].down, entry, transaction));
          await runtimes.right!.close(); await startRuntime('right', 'v1'); state.phase = 'rollback'; stale();
          entry.explanation = 'The shared database was down-migrated with every row retained. The right app process was replaced with a new v1 process; both apps now run old code against the preserved shared data.';
        }
        const observations = Object.values(entry.observations);
        entry.outcome = observations.some(observation => observation.outcome === 'inconclusive') ? 'inconclusive'
          : observations.some(observation => observation.outcome === 'failed') ? 'failed' : 'passed';
        if (!entry.explanation) entry.explanation = observations.map(observation => observation.outcome === 'passed'
          ? `Session ${observation.sessionId} decoded as ${observation.userId}; the note action completed.`
          : observation.error?.includes('42703') ? 'The old process queried session_payload, which the migration renamed. Its session read failed, so the note action could not proceed.'
          : observation.error?.includes('v1 requires flat') ? 'The selected row is still present with its v2 write marker, but old code cannot decode the nested principal data. Its note action could not proceed.'
          : observation.error ?? 'The observation is inconclusive.').join(' ');
      } catch (error) { entry.outcome = error instanceof AppFailure && error.compatibility ? 'failed' : 'inconclusive'; entry.explanation = errorText(error); }
      try { await inspect(entry); }
      catch (error) { state.databases = []; entry.outcome = 'inconclusive'; entry.explanation += ` Database state unavailable: ${errorText(error)}`; }
      if (entry.outcome === 'inconclusive') available = false;
      entry.phase = state.phase; entry.durationMs = performance.now() - start;
      state.revision++; state.updatedAt = new Date().toISOString(); state.events.push(entry);
      const snapshot = copy(); accepted.set(command.commandId, { command: identity, snapshot }); return structuredClone(snapshot);
    }),
    close: () => enqueue(async () => {
      if (closed) return; available = false;
      await releaseResources(); closed = true;
    }),
  };
}
