import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import * as v1 from '../../engine/specimen/v1.js';
import * as breaking from '../../engine/specimen/v2-breaking.js';
import * as compatible from '../../engine/specimen/v2-compatible.js';
import { SessionContractError, type Release, type SqlClient } from '../../engine/specimen/types.js';
import type { DatabaseTarget, Failure, FieldnotesConfig, InitializeInput, Observation, OperationResult, ReleaseName, Session, Snapshot, Trace } from './protocol.js';

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}
const canonical = (value: unknown): string => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  : JSON.stringify(value) ?? 'null';
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const releases: Record<ReleaseName, Release> = { v1, 'v2-breaking': breaking, 'v2-compatible': compatible };
const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const notesSQL = 'CREATE TABLE notes (user_id TEXT PRIMARY KEY, body TEXT NOT NULL)';
const metadataSQL = 'CREATE TABLE fieldnotes_metadata (singleton BOOLEAN PRIMARY KEY CHECK (singleton), database_id TEXT NOT NULL, fixture_digest TEXT NOT NULL)';
const fixedSQL: Record<string, string> = {
  'note.read': 'SELECT body FROM notes WHERE user_id = $1',
  'note.save': 'INSERT INTO notes (user_id, body) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET body = EXCLUDED.body RETURNING body',
  'db.identity': 'SELECT database_id, fixture_digest, version() AS postgres_version, current_database() AS database_name FROM fieldnotes_metadata WHERE singleton = true',
  'db.columns': "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions' ORDER BY ordinal_position",
  'db.rows': 'SELECT * FROM sessions ORDER BY id LIMIT 100',
  'db.notes': 'SELECT user_id, body FROM notes ORDER BY user_id LIMIT 100',
};

function text(value: unknown, name: string, max: number, allowLines = false): string {
  if (typeof value !== 'string' || [...value].length > max || (!allowLines && !value.trim()) ||
    (allowLines ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value)) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value;
}
function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new HttpError(400, `Invalid ${name}.`);
  return value;
}
function session(input: unknown): Session {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Session is required.');
  const s = input as Session;
  return { id: id(s.id, 'session id'), userId: text(s.userId, 'user', 48), role: text(s.role, 'role', 32), writeMarker: id(s.writeMarker, 'write marker') };
}
export function failure(error: unknown): Failure {
  const e = error as { name?: string; code?: string; message?: string; cause?: unknown };
  const code = e?.code ? String(e.code) : undefined;
  const message = e?.message || 'The application could not complete its database request.';
  const cause = code === '42703' ? 'The session column this release reads is missing from the database.'
    : e?.name === 'SessionContractError' || error instanceof SessionContractError ? 'The stored session format does not match this release.'
      : code === '42P01' ? 'The database table required by this application is unavailable.'
        : 'The runtime could not establish the result of this operation.';
  return { name: error instanceof SessionContractError ? 'SessionContractError' : e?.name || 'Error', message, ...(code ? { code } : {}), cause };
}
function compatibleFailure(error: Failure): boolean { return error.name === 'SessionContractError' || error.code === '42703'; }

export interface ApplicationOptions { release: ReleaseName; databaseURL: string; stateFile: string }

export async function createApplication(options: ApplicationOptions) {
  if (!Object.hasOwn(releases, options.release)) throw new HttpError(400, 'Unknown bundled release.');
  const release = releases[options.release];
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const pool = new pg.Pool({ connectionString: options.databaseURL, max: 4, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, statement_timeout: 10_000, query_timeout: 12_000 });
  // An idle connection can disappear independently; the next request obtains a new connection.
  pool.on('error', () => {});
  let config: FieldnotesConfig;
  try { config = JSON.parse(await readFile(options.stateFile, 'utf8')) as FieldnotesConfig; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await pool.end(); throw error; }
    config = { databaseId: randomUUID(), target: { kind: 'local' }, selectedSessionId: null, autonomous: false, fixtureDigest: null, initialized: false, revision: 0, accepted: {} };
  }
  let postgresVersion: string | null = null;
  let observation: Observation | null = null;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => { const result = queue.then(work); queue = result.catch(() => undefined); return result; };
  const fixtureSQL = await readFile(new URL('../../engine/specimen/fixture.sql', import.meta.url), 'utf8');
  const migrations = {
    breaking: { up: await readFile(new URL('../../engine/specimen/breaking-up.sql', import.meta.url), 'utf8'), down: await readFile(new URL('../../engine/specimen/breaking-down.sql', import.meta.url), 'utf8') },
    compatible: { up: await readFile(new URL('../../engine/specimen/compatible-up.sql', import.meta.url), 'utf8'), down: await readFile(new URL('../../engine/specimen/compatible-down.sql', import.meta.url), 'utf8') },
  };
  const sourcePaths = ['app.ts', 'server.ts', 'protocol.ts', 'web/app.js', 'web/index.html', 'web/style.css', '../../engine/specimen/v1.ts', '../../engine/specimen/v2-breaking.ts', '../../engine/specimen/v2-compatible.ts', '../../engine/specimen/types.ts'];
  const sourceDigest = digest({ files: await Promise.all(sourcePaths.map(async path => ({ path, source: await readFile(new URL(path, import.meta.url), 'utf8') }))), fixtureSQL, migrations });
  const statements = new Map(Object.entries(fixedSQL));
  // Obtain the allowlisted SQL from the same original functions that execute requests.
  for (const [name, implementation] of Object.entries(releases)) {
    const sample = { id: 'catalog-session', userId: 'catalog-user', role: 'viewer', writeMarker: 'catalog-write' };
    for (const operation of ['read', 'write'] as const) {
      const capture: SqlClient = { query: async sql => {
        statements.set(`${name}.${operation}`, sql);
        return { rows: [{ id: sample.id, session_payload: sample, identity_payload: { principal: { id: sample.userId, role: sample.role }, writeMarker: sample.writeMarker } }] };
      } };
      if (operation === 'read') await implementation.readSession(capture, sample.id);
      else await implementation.writeSession(capture, sample);
    }
  }
  async function persist() {
    await mkdir(dirname(options.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${options.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
    await rename(temporary, options.stateFile);
  }
  function snapshot(): Snapshot {
    return structuredClone({ schemaVersion: 1, revision: config.revision, release: options.release, instanceId, pid: process.pid, startedAt,
      database: { id: config.target.kind === 'local' ? config.databaseId : config.target.databaseId, kind: config.target.kind, postgresVersion },
      selectedSessionId: config.selectedSessionId, autonomous: config.autonomous, sourceDigest, fixtureDigest: config.fixtureDigest, observation });
  }
  async function local(sql: string, parameters: unknown[], trace: Trace[], client?: pg.PoolClient) {
    const step: Trace = { sql, parameters: structuredClone(parameters), databaseId: config.databaseId, at: new Date().toISOString(), durationMs: 0 };
    trace.push(step); const start = performance.now();
    try {
      const results = await (client ?? pool).query(sql, parameters);
      const rows = (Array.isArray(results) ? results.flatMap(result => result.rows ?? []) : results.rows) as Record<string, unknown>[];
      step.rows = structuredClone(rows); return { rows };
    } catch (error) { step.error = failure(error); throw error; }
    finally { step.durationMs = Math.round((performance.now() - start) * 100) / 100; }
  }
  async function query(sql: string, parameters: unknown[] = [], trace: Trace[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (closed) throw new HttpError(410, 'Application is closed.');
    const statement = [...statements].find(([, allowed]) => normalize(allowed) === normalize(sql));
    if (!statement) throw new Error('The trusted app attempted an unknown statement.');
    if (config.target.kind === 'local') return local(sql, parameters, trace);
    const target = config.target;
    try {
      const response = await fetch(`${target.url}/admin/query`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json',
        'x-daytona-skip-preview-warning': 'true', ...(target.previewToken ? { 'x-daytona-preview-token': target.previewToken } : {}) },
        body: JSON.stringify({ statement: statement[0], parameters }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`The database gateway returned HTTP ${response.status}.`);
      const data = await response.json() as { rows?: Record<string, unknown>[]; trace: Trace[]; error?: Failure; databaseId: string };
      if (data.databaseId !== target.databaseId || !Array.isArray(data.trace)) throw new Error('The database gateway identity does not match the configured database.');
      trace.push(...data.trace);
      if (data.error) throw Object.assign(new Error(data.error.message), data.error);
      if (!Array.isArray(data.rows)) throw new Error('The database gateway returned an invalid query result.');
      return { rows: data.rows };
    } catch (error) {
      if (!trace.some(step => step.sql === sql && step.error)) trace.push({ sql, parameters, databaseId: target.databaseId, at: new Date().toISOString(), durationMs: 0, error: failure(error) });
      throw error;
    }
  }
  async function identify(trace: Trace[]) {
    const { rows } = await query(fixedSQL['db.identity'], [], trace);
    const identity = rows[0];
    if (!identity || identity.database_id !== snapshot().database.id) throw new Error('The actual database identity differs from the configured database.');
    postgresVersion = String(identity.postgres_version);
    config.fixtureDigest = String(identity.fixture_digest);
  }
  async function business(operation: 'read' | 'save', note?: string): Promise<OperationResult> {
    const trace: Trace[] = [];
    observation = { operation, outcome: 'inconclusive', observedAt: new Date().toISOString(), release: options.release,
      instanceId, databaseId: snapshot().database.id, sessionId: config.selectedSessionId ?? '', trace };
    try {
      if (!config.selectedSessionId) throw new Error('The application has not been initialized with a session.');
      await identify(trace);
      const actor = await release.readSession({ query: (sql, params) => query(sql, params, trace) }, config.selectedSessionId);
      const result = operation === 'save'
        ? await query(fixedSQL['note.save'], [actor.userId, note!], trace)
        : await query(fixedSQL['note.read'], [actor.userId], trace);
      Object.assign(observation, { outcome: 'passed', userId: actor.userId, role: actor.role, writeMarker: actor.writeMarker, note: String(result.rows[0]?.body ?? '') });
    } catch (error) {
      observation.error = failure(error); observation.outcome = compatibleFailure(observation.error) ? 'failed' : 'inconclusive';
    }
    config.revision++; await persist();
    return { snapshot: snapshot(), trace, outcome: observation.outcome, ...(observation.error ? { error: observation.error } : {}) };
  }
  async function runAdmin(work: (trace: Trace[]) => Promise<void>, preserveObservation = false): Promise<OperationResult> {
    const trace: Trace[] = [];
    try { await work(trace); config.revision++; if (!preserveObservation) observation = null; await persist(); return { snapshot: snapshot(), trace, outcome: 'passed' }; }
    catch (error) {
      if (error instanceof HttpError) throw error;
      config.revision++; observation = null; await persist();
      return { snapshot: snapshot(), trace, outcome: 'inconclusive', error: failure(error) };
    }
  }
  try { postgresVersion = (await pool.query('SELECT version() AS version')).rows[0].version; await persist(); }
  catch (error) { await pool.end(); throw error; }
  return {
    snapshot,
    read: () => enqueue(() => business('read')),
    note: (input: unknown, admin = false) => enqueue(async () => {
      const data = input as { note?: unknown; commandId?: unknown };
      const commandId = id(data?.commandId, 'command id');
      const note = text(data?.note, 'note', 280, true);
      const inputDigest = digest({ note, sessionId: config.selectedSessionId, databaseId: snapshot().database.id, release: options.release });
      const previous = config.accepted[commandId];
      if (previous) { if (previous.input !== inputDigest) throw new HttpError(409, 'This command id was already used for another action.'); return structuredClone(previous.result); }
      if (!admin && config.autonomous) throw new HttpError(409, 'Pause the rehearsal before editing.');
      if (Object.keys(config.accepted).length >= 100) throw new HttpError(409, 'This demo has reached its 100 save limit.');
      const result = await business('save', note);
      config.accepted[commandId] = { input: inputDigest, result: structuredClone(result) }; await persist(); return result;
    }),
    initialize: (input: InitializeInput) => enqueue(async () => {
      const original = session({ id: input?.sessionId, userId: text(input?.label, 'label', 48).trim(), role: 'viewer', writeMarker: input?.writeMarker });
      const note = text(input?.note, 'note', 280, true);
      const fixtureDigest = digest({ fixtureSQL, notesSQL, metadataSQL, original, note });
      if (config.initialized) { if (fixtureDigest !== config.fixtureDigest) throw new HttpError(409, 'The existing database has another fixture.'); return { snapshot: snapshot(), trace: [], outcome: 'passed' as const }; }
      if (config.target.kind !== 'local') throw new HttpError(409, 'Initialize the local database before connecting a shared database.');
      return runAdmin(async trace => {
        const client = await pool.connect();
        try {
          await local('BEGIN', [], trace, client);
          await local(fixtureSQL, [], trace, client); await local(notesSQL, [], trace, client); await local(metadataSQL, [], trace, client);
          await v1.writeSession({ query: (sql, params = []) => local(sql, params, trace, client) }, original);
          await local(fixedSQL['note.save'], [original.userId, note], trace, client);
          await local('INSERT INTO fieldnotes_metadata (singleton, database_id, fixture_digest) VALUES (true, $1, $2)', [config.databaseId, fixtureDigest], trace, client);
          await local('COMMIT', [], trace, client);
          config.selectedSessionId = original.id; config.fixtureDigest = fixtureDigest; config.initialized = true;
        } catch (error) { await local('ROLLBACK', [], trace, client); throw error; }
        finally { client.release(); }
      });
    }),
    configure: (input: { database?: DatabaseTarget; selectedSessionId?: string; autonomous?: boolean }) => enqueue(async () => {
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['database', 'selectedSessionId', 'autonomous'].includes(key))) throw new HttpError(400, 'Invalid configuration.');
      if (input.autonomous !== undefined && typeof input.autonomous !== 'boolean') throw new HttpError(400, 'Invalid autonomous flag.');
      const selected = input.selectedSessionId === undefined ? config.selectedSessionId : id(input.selectedSessionId, 'session id');
      const target = input.database ?? config.target;
      if (!target || !['local', 'gateway'].includes(target.kind)) throw new HttpError(400, 'Invalid database target.');
      if (target.kind === 'gateway') {
        let url: URL; try { url = new URL(target.url); } catch { throw new HttpError(400, 'Invalid gateway URL.'); }
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new HttpError(400, 'Gateway URL must be an HTTPS origin.');
        id(target.databaseId, 'database id'); text(target.token, 'gateway token', 256);
        if (target.previewToken !== undefined) text(target.previewToken, 'preview token', 4096);
      }
      const sameDatabase = canonical(target) === canonical(config.target);
      const sameSession = selected === config.selectedSessionId;
      return runAdmin(async trace => {
        const previous = config.target;
        config.target = target.kind === 'local' ? { kind: 'local' } : { ...target, url: target.url.replace(/\/$/, '') };
        try { if (config.initialized) await identify(trace); } catch (error) { config.target = previous; throw error; }
        config.selectedSessionId = selected; config.autonomous = input.autonomous ?? config.autonomous;
      }, sameDatabase && sameSession);
    }),
    migrate: (input: { direction: 'up' | 'down'; variant: 'breaking' | 'compatible' }) => enqueue(async () => {
      if (!input || !['up', 'down'].includes(input.direction) || !['breaking', 'compatible'].includes(input.variant)) throw new HttpError(400, 'Choose a bundled migration.');
      if (config.target.kind !== 'local' || !config.initialized) throw new HttpError(409, 'Migrate this app’s initialized local database.');
      return runAdmin(async trace => {
        const client = await pool.connect();
        try {
          await local('BEGIN', [], trace, client);
          const columns = (await local(fixedSQL['db.columns'], [], trace, client)).rows.map(row => row.column_name).sort();
          const expected = input.direction === 'up' ? ['id', 'session_payload']
            : input.variant === 'breaking' ? ['id', 'identity_payload'] : ['id', 'identity_payload', 'session_payload'];
          if (canonical(columns) !== canonical(expected)) throw new HttpError(409, 'The database is not in the required migration phase.');
          await local(migrations[input.variant][input.direction], [], trace, client); await local('COMMIT', [], trace, client);
        }
        catch (error) { await local('ROLLBACK', [], trace, client); throw error; }
        finally { client.release(); }
      });
    }),
    writeSession: (input: { session: Session }) => enqueue(async () => {
      const next = session(input?.session);
      return runAdmin(async trace => {
        await identify(trace); await release.writeSession({ query: (sql, params) => query(sql, params, trace) }, next); config.selectedSessionId = next.id;
      });
    }),
    rows: () => enqueue(async () => {
      const trace: Trace[] = []; await identify(trace);
      const columns = (await query(fixedSQL['db.columns'], [], trace)).rows;
      const rows = (await query(fixedSQL['db.rows'], [], trace)).rows;
      const notes = (await query(fixedSQL['db.notes'], [], trace)).rows;
      return { databaseId: snapshot().database.id, columns, rows, notes, trace };
    }),
    gateway: (input: { statement?: unknown; parameters?: unknown }) => enqueue(async () => {
      const sql = typeof input?.statement === 'string' ? statements.get(input.statement) : undefined;
      if (!sql || !Array.isArray(input.parameters) || input.parameters.length > 3 || input.parameters.some(value => typeof value !== 'string' || Buffer.byteLength(value) > 4096)) throw new HttpError(400, 'Invalid trusted statement or parameters.');
      const trace: Trace[] = [];
      try {
        const result = await local(sql, input.parameters, trace);
        if (String(input.statement).endsWith('.write') || input.statement === 'note.save') {
          observation = null; config.revision++; await persist();
        }
        return { ...result, trace, databaseId: config.databaseId };
      }
      catch (error) { return { error: failure(error), trace, databaseId: config.databaseId }; }
    }),
    close: async () => { closed = true; await queue; await pool.end(); },
  };
}
export type Application = Awaited<ReturnType<typeof createApplication>>;
