import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Outcome } from '../shared/contracts.js';
import type { LabAction, LabCommand, LabCreateInput, LabEvent, LabReadResult, LabSnapshot } from '../shared/lab.js';
import { getInputDigests } from './index.js';
import * as v1 from './specimen/v1.js';
import * as breaking from './specimen/v2-breaking.js';
import * as compatible from './specimen/v2-compatible.js';
import { SessionContractError, type Release, type Session, type SqlClient } from './specimen/types.js';

const fixtureSQL = readFileSync(new URL('./specimen/fixture.sql', import.meta.url), 'utf8');
const migrations = {
  breaking: {
    up: readFileSync(new URL('./specimen/breaking-up.sql', import.meta.url), 'utf8'),
    down: readFileSync(new URL('./specimen/breaking-down.sql', import.meta.url), 'utf8'),
  },
  compatible: {
    up: readFileSync(new URL('./specimen/compatible-up.sql', import.meta.url), 'utf8'),
    down: readFileSync(new URL('./specimen/compatible-down.sql', import.meta.url), 'utf8'),
  },
};
const scope = 'One persistent, disposable PostgreSQL database in PGlite executes trusted bundled session functions and migrations. Your label is stored through bound SQL parameters. The same rows remain through your actions and rollback. This lab uses synthetic session records, makes no authentication requests, and does not execute arbitrary code or access production data.';
const actions: LabAction[] = ['read-old', 'migrate', 'write-new', 'read-new', 'rollback'];

export class LabError extends Error {
  constructor(public readonly code: 'invalid-input' | 'invalid-command' | 'revision-conflict' | 'invalid-phase' | 'event-limit' | 'closed', message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'LabError';
  }
}

export interface LabSession {
  snapshot(): Promise<LabSnapshot>;
  execute(command: LabCommand): Promise<LabSnapshot>;
  close(): Promise<void>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}
function errorText(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const text = error instanceof Error ? error.message : String(error);
  return code ? `PostgreSQL ${code}: ${text}` : text;
}
function readErrorOutcome(error: unknown): Outcome {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return error instanceof SessionContractError || code === '42703' ? 'failed' : 'inconclusive';
}
function plainCause(error: unknown, release: 'v1' | 'v2', event: LabEvent): string {
  if (error instanceof SessionContractError) {
    const payload = event.sql.flatMap(statement => statement.rows ?? [])[0]?.session_payload;
    if (release === 'v1' && payload && typeof payload === 'object' && 'principal' in payload) {
      return 'The row is still present, but v1 expects flat userId and role fields. This row contains the nested principal format written by v2, so v1 cannot decode it.';
    }
    return `The ${release} reader could not decode the selected row according to its session contract: ${errorText(error)}`;
  }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === '42703' && release === 'v1'
    ? 'The old reader asks for session_payload. The migration renamed that column to identity_payload, so PostgreSQL rejects the old query before a session can be decoded.'
    : `The database could not establish a complete result: ${errorText(error)}`;
}

type QueryRunner = Pick<PGlite, 'query' | 'exec'>;

export async function createLabSession(input: LabCreateInput): Promise<LabSession> {
  if (!input || (input.variant !== 'breaking' && input.variant !== 'compatible') || typeof input.label !== 'string') {
    throw new LabError('invalid-input', 'Choose a bundled variant and a session label.');
  }
  const label = input.label.trim();
  if (!label || [...label].length > 48 || /[\u0000-\u001f\u007f-\u009f]/.test(input.label)) {
    throw new LabError('invalid-input', 'Use a label of 1 to 48 characters without control characters.');
  }
  const variant = input.variant;
  const original: Session = { id: `lab-v1-${randomUUID()}`, userId: label, role: 'viewer', writeMarker: `lab-v1-write-${randomUUID()}` };
  const createdAt = new Date().toISOString();
  const state: LabSnapshot = {
    id: randomUUID(), revision: 0, variant, phase: 'original', label, createdAt, updatedAt: createdAt,
    databaseId: randomUUID(), sourceDigest: getInputDigests(variant).sourceDigest,
    fixtureDigest: digest({ fixtureSQL, original }), columns: [], rows: [], selectedSessionId: original.id,
    events: [], allowedActions: [], scope,
  };
  let db: PGlite | undefined;
  let available = false;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const accepted = new Map<string, { command: string; snapshot: LabSnapshot }>();
  const expectedSessions = new Map<string, Session>([[original.id, original]]);
  const v2: Release = variant === 'breaking' ? breaking : compatible;

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  function allowed(): LabAction[] {
    if (!available || closed || state.events.length >= 100) return [];
    if (state.phase === 'original') return ['read-old', 'migrate'];
    if (state.phase === 'rolled-back') return ['read-old'];
    return ['read-old', ...(!state.newSessionId ? ['write-new' as const] : []), 'read-new', 'rollback'];
  }
  function copy(): LabSnapshot {
    state.allowedActions = allowed();
    return structuredClone(state);
  }
  function client(runner: QueryRunner, event: LabEvent): SqlClient {
    return {
      async query(query, parameters) {
        const sql: LabEvent['sql'][number] = { query, ...(parameters ? { parameters: structuredClone(parameters) } : {}) };
        event.sql.push(sql);
        try {
          const result = await runner.query<Record<string, unknown>>(query, parameters);
          sql.rows = structuredClone(result.rows);
          return result;
        } catch (error) { sql.error = errorText(error); throw error; }
      },
    };
  }
  async function executeSQL(runner: QueryRunner, query: string, event: LabEvent): Promise<void> {
    const sql: LabEvent['sql'][number] = { query };
    event.sql.push(sql);
    try {
      const batches = await runner.exec(query);
      sql.rows = batches.flatMap(batch => batch.rows as Record<string, unknown>[]);
    } catch (error) { sql.error = errorText(error); throw error; }
  }
  async function inspect(event?: LabEvent): Promise<void> {
    const runner = event ? client(db!, event) : db!;
    const columns = await runner.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sessions' ORDER BY ordinal_position`);
    const rows = await runner.query('SELECT * FROM sessions ORDER BY id');
    state.columns = columns.rows.map(row => String((row as Record<string, unknown>).column_name));
    state.rows = rows.rows as Record<string, unknown>[];
  }
  function makeEvent(action: LabEvent['action'], id: string): LabEvent {
    return { id, action, at: new Date().toISOString(), outcome: 'inconclusive', title: '', explanation: '', sql: [], durationMs: 0 };
  }
  async function read(release: Release, releaseName: 'v1' | 'v2', event: LabEvent): Promise<void> {
    const result: LabReadResult = { release: releaseName, sessionId: state.selectedSessionId, outcome: 'inconclusive' };
    event.read = result;
    try {
      const observed = await release.readSession(client(db!, event), state.selectedSessionId);
      const expected = expectedSessions.get(state.selectedSessionId)!;
      if (canonical(observed) !== canonical(expected)) throw new SessionContractError(`Decoded identity did not match the written session: ${JSON.stringify(observed)}`);
      Object.assign(result, { outcome: 'passed', userId: observed.userId, role: observed.role, writeMarker: observed.writeMarker });
      event.outcome = 'passed';
      event.explanation = `${releaseName} decoded the selected row as ${observed.userId} (${observed.role}) and preserved its exact session ID and write marker.`;
    } catch (error) {
      result.outcome = event.outcome = readErrorOutcome(error);
      result.error = errorText(error);
      event.explanation = plainCause(error, releaseName, event);
    }
  }

  const create = makeEvent('create', randomUUID());
  const createStart = performance.now();
  try {
    db = new PGlite();
    await db.waitReady;
    await client(db, create).query('SELECT version() AS postgres_version');
    await db.transaction(async transaction => {
      await executeSQL(transaction, fixtureSQL, create);
      await v1.writeSession(client(transaction, create), original);
    });
    available = true;
    await inspect(create);
    create.outcome = 'passed';
    create.title = 'Your session is stored';
    create.explanation = `Created ${label}'s session in the original flat format. This database stays alive through each action; your selected row is ${original.id}.`;
  } catch (error) {
    available = false;
    create.title = 'Database setup is inconclusive';
    create.explanation = `Could not establish the lab fixture: ${errorText(error)}`;
    if (db) { try { await db.close(); } catch { /* close() below retries releasing the failed database. */ } }
  }
  create.durationMs = performance.now() - createStart;
  state.events.push(create);

  return {
    snapshot: () => enqueue(async () => {
      if (closed) throw new LabError('closed', 'This lab session is closed.', 410);
      if (available) await inspect();
      return copy();
    }),
    execute: (command: LabCommand) => enqueue(async () => {
      if (closed) throw new LabError('closed', 'This lab session is closed.', 410);
      if (!command || typeof command.commandId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(command.commandId) || !Number.isSafeInteger(command.expectedRevision)
        || command.expectedRevision < 0 || !actions.includes(command.action) || Object.keys(command).length !== 3) {
        throw new LabError('invalid-command', 'Supply a valid command ID, revision and action.');
      }
      const identity = canonical(command);
      const prior = accepted.get(command.commandId);
      if (prior) {
        if (prior.command !== identity) throw new LabError('invalid-command', 'This command ID was already used for a different request.', 409);
        return structuredClone(prior.snapshot);
      }
      if (command.expectedRevision !== state.revision) throw new LabError('revision-conflict', `Expected revision ${state.revision}, received ${command.expectedRevision}.`, 409);
      if (state.events.length >= 100) throw new LabError('event-limit', 'This lab has reached its 100-event limit. Start a new session.', 409);
      if (!allowed().includes(command.action)) throw new LabError('invalid-phase', `Action ${command.action} is unavailable while the database is ${state.phase}.`, 409);
      const event = makeEvent(command.action, command.commandId);
      const start = performance.now();
      try {
        switch (command.action) {
          case 'read-old':
            event.title = 'Read with the old app';
            await read(v1, 'v1', event);
            break;
          case 'read-new':
            event.title = 'Read with the new app';
            await read(v2, 'v2', event);
            break;
          case 'migrate':
            event.title = 'Apply the schema migration';
            await db!.transaction(transaction => executeSQL(transaction, migrations[variant].up, event));
            state.phase = 'upgraded';
            event.outcome = 'passed';
            event.explanation = 'Applied the migration to this database. The existing rows remain; inspect the live column names and payloads below.';
            break;
          case 'write-new': {
            event.title = 'Write a session with the new app';
            const fresh: Session = { id: `lab-v2-${randomUUID()}`, userId: label, role: 'editor', writeMarker: `lab-v2-write-${randomUUID()}` };
            await v2.writeSession(client(db!, event), fresh);
            expectedSessions.set(fresh.id, fresh);
            state.newSessionId = state.selectedSessionId = fresh.id;
            event.outcome = 'passed';
            event.explanation = `v2 wrote a new session for ${label}. That exact row is now selected for subsequent reads and rollback: ${fresh.id}.`;
            break;
          }
          case 'rollback':
            event.title = 'Roll back on the same database';
            await db!.transaction(transaction => executeSQL(transaction, migrations[variant].down, event));
            state.phase = 'rolled-back';
            event.outcome = 'passed';
            event.explanation = `Rolled back the schema without resetting the database. The selected row ${state.selectedSessionId} remains for the old app to read.`;
            break;
        }
      } catch (error) {
        event.outcome = 'inconclusive';
        event.explanation = `The action could not establish a complete result: ${errorText(error)}`;
      }
      try { await inspect(event); }
      catch (error) {
        state.columns = []; state.rows = [];
        event.outcome = 'inconclusive';
        event.explanation += ` State inspection also failed; current columns and rows are unavailable: ${errorText(error)}`;
      }
      if (event.outcome === 'inconclusive') available = false;
      event.durationMs = performance.now() - start;
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      state.events.push(event);
      const snapshot = copy();
      accepted.set(command.commandId, { command: identity, snapshot });
      return structuredClone(snapshot);
    }),
    close: () => enqueue(async () => {
      if (closed) return;
      available = false;
      if (db && !db.closed) await db.close();
      closed = true;
    }),
  };
}
