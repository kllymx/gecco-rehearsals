import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Outcome, RehearsalRun, ScenarioId, ScenarioResult, Specimen, TraceStep, Variant } from '../shared/contracts.js';
import * as v1 from './specimen/v1.js';
import * as breaking from './specimen/v2-breaking.js';
import * as compatible from './specimen/v2-compatible.js';
import { SessionContractError, type Release, type Session, type SqlClient } from './specimen/types.js';

// These snapshots are the actual bundled files, loaded with this engine module.
// The specimen is trusted local code, not user-supplied executable input.
const specimenPath = new URL('./specimen/', import.meta.url);
const sources = Object.fromEntries([
  'types.ts', 'v1.ts', 'v2-breaking.ts', 'v2-compatible.ts', 'fixture.sql',
  'breaking-up.sql', 'breaking-down.sql', 'compatible-up.sql', 'compatible-down.sql',
].map(path => [path, readFileSync(new URL(path, specimenPath), 'utf8')]));

export const CONTRACT = 'Throughout a rolling upgrade and a supported rollback, each active release must read sessions written by either release, preserving session ID, user ID, role and the exact write marker. Rollback must read a session written by v2 before rollback, without resetting the database.';
export const SCOPE = 'Trusted bundled TypeScript/SQL specimen on real PostgreSQL in PGlite 0.5.8. Each trial owns a disposable in-memory database; state is preserved inside the trial. This demonstrates observed transition compatibility, not arbitrary-repository execution, production isolation or proof that a release is safe.';

function assertVariant(variant: unknown): asserts variant is Variant {
  if (variant !== 'breaking' && variant !== 'compatible') {
    throw new TypeError('variant must be "breaking" or "compatible"');
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export function getInputDigests(variant: Variant): { sourceDigest: string; fixtureDigest: string } {
  assertVariant(variant);
  return {
    sourceDigest: digest({ contract: CONTRACT, files: {
      'types.ts': sources['types.ts'], 'v1.ts': sources['v1.ts'],
      [`v2-${variant}.ts`]: sources[`v2-${variant}.ts`],
      [`${variant}-up.sql`]: sources[`${variant}-up.sql`],
      [`${variant}-down.sql`]: sources[`${variant}-down.sql`],
    } }),
    fixtureDigest: digest({ 'fixture.sql': sources['fixture.sql'] }),
  };
}

export function getSpecimen(): Specimen {
  return {
    id: 'session-record-v2',
    title: 'Session record migration',
    description: 'Move session identity into a principal object. Isolated v1 and v2 checks pass, but a rename breaks old processes and a schema-only rollback strands new writes. The compatible alternative retains the legacy column and dual-writes until the rollback window closes.',
    contract: CONTRACT,
    currentRelease: 'v1 · flat session record',
    proposedRelease: 'v2 · nested principal record',
    files: [
      { path: 'session.ts', before: sources['v1.ts'], breaking: sources['v2-breaking.ts'], compatible: sources['v2-compatible.ts'] },
      { path: 'migration.up.sql', before: '-- v1 has no upgrade migration.\n', breaking: sources['breaking-up.sql'], compatible: sources['compatible-up.sql'] },
      { path: 'migration.down.sql', before: '-- v1 has no downgrade migration.\n', breaking: sources['breaking-down.sql'], compatible: sources['compatible-down.sql'] },
      { path: 'fixture.sql', before: sources['fixture.sql'], breaking: sources['fixture.sql'], compatible: sources['fixture.sql'] },
      { path: 'types.ts', before: sources['types.ts'], breaking: sources['types.ts'], compatible: sources['types.ts'] },
    ],
  };
}

const trialDefinitions: { id: ScenarioId; title: string; description: string; expected: string }[] = [
  { id: 'control', title: 'Current release', description: 'v1 reads the fixture and its own new write on the original schema.', expected: 'v1 returns the exact original and newly written session identities.' },
  { id: 'upgrade', title: 'Upgraded release', description: 'Apply the migration. v2 reads migrated sessions and its own marked new write.', expected: 'v2 returns the exact fixture identity and its new session identity after migration.' },
  { id: 'mixed', title: 'Mixed versions', description: 'Keep v1 and v2 active on the upgraded database and read across version boundaries.', expected: 'v1 reads migrated and v2-created sessions; v2 reads a session written by an old process.' },
  { id: 'rollback', title: 'Rollback after writes', description: 'v2 creates a uniquely marked session. Roll back on that same database, then let v1 read that exact row.', expected: 'After rollback, v1 returns the exact identity and marker of the session written by v2 before rollback.' },
];

const seed: Session = { id: 'seed-session', userId: 'demo-user-1', role: 'viewer', writeMarker: 'fixture-seed' };

function errorText(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `PostgreSQL ${code}: ${message}` : message;
}

function errorOutcome(error: unknown): Outcome {
  if (error instanceof SessionContractError) return 'failed';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  // Data/constraint errors and missing schema objects are evidence about the change.
  // Connection, resource exhaustion, cancellation and unknown runtime failures are not.
  return /^(22|23)/.test(code) || ['42703', '42P01', '42701', '42804', '42883'].includes(code)
    ? 'failed' : 'inconclusive';
}

const stateSQL = `SELECT
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.ordinal_position) FROM (
    SELECT column_name, data_type, is_nullable, column_default, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sessions'
  ) c) AS columns,
  (SELECT jsonb_agg(jsonb_build_object('name', conname, 'definition', pg_get_constraintdef(oid)) ORDER BY conname)
    FROM pg_constraint WHERE conrelid = 'public.sessions'::regclass) AS constraints,
  (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb) FROM sessions s) AS sessions`;

async function runTrial(definition: typeof trialDefinitions[number], variant: Variant): Promise<ScenarioResult> {
  const start = performance.now();
  const result: ScenarioResult = {
    ...definition, outcome: 'inconclusive', explanation: '', steps: [],
    fixtureId: randomUUID(), stateFingerprint: 'unavailable', durationMs: 0,
  };
  let db: PGlite | undefined;
  let initialized = false;
  let operationLabel = '';
  let operationIsSetup = false;
  let sequence = 0;
  const append = (step: Omit<TraceStep, 'id'>) => result.steps.push({ id: `${definition.id}-${++sequence}`, ...step });

  async function operation(label: string, action: () => Promise<string>, setup = false): Promise<boolean> {
    const stepStart = performance.now();
    operationLabel = label;
    operationIsSetup = setup;
    try {
      const observation = await action();
      append({ label, observation, outcome: 'passed', durationMs: performance.now() - stepStart });
      return true;
    } catch (error) {
      append({ label, observation: errorText(error), outcome: setup ? 'inconclusive' : errorOutcome(error), durationMs: performance.now() - stepStart });
      return false;
    }
  }

  const client: SqlClient = {
    async query(sql, parameters) {
      const queryStart = performance.now();
      try {
        const observed = await db!.query<Record<string, unknown>>(sql, parameters);
        append({ label: `${operationLabel} · SQL`, sql, rows: observed.rows,
          observation: `${observed.rows.length} row(s) returned.${parameters ? ` Bound parameters: ${JSON.stringify(parameters)}` : ''}`,
          outcome: 'passed', durationMs: performance.now() - queryStart });
        return observed;
      } catch (error) {
        append({ label: `${operationLabel} · SQL`, sql,
          observation: `${errorText(error)}${parameters ? ` Bound parameters: ${JSON.stringify(parameters)}` : ''}`,
          outcome: operationIsSetup ? 'inconclusive' : errorOutcome(error), durationMs: performance.now() - queryStart });
        throw error;
      }
    },
  };

  async function executeSQL(label: string, sql: string, setup = false): Promise<boolean> {
    const stepStart = performance.now();
    try {
      const observed = await db!.exec(sql);
      append({ label, sql, rows: observed.flatMap(batch => batch.rows as Record<string, unknown>[]),
        observation: `${observed.length} SQL statement(s) completed on fixture ${result.fixtureId}.`,
        outcome: 'passed', durationMs: performance.now() - stepStart });
      return true;
    } catch (error) {
      append({ label, sql, observation: errorText(error), outcome: setup ? 'inconclusive' : errorOutcome(error), durationMs: performance.now() - stepStart });
      return false;
    }
  }

  async function read(label: string, release: Release, expected: Session, setup = false): Promise<boolean> {
    return operation(label, async () => {
      const observed = await release.readSession(client, expected.id);
      if (canonical(observed) !== canonical(expected)) {
        throw new SessionContractError(`Session contract violated. Expected ${JSON.stringify(expected)}; observed ${JSON.stringify(observed)}.`);
      }
      return `Contract satisfied: ${JSON.stringify(observed)}`;
    }, setup);
  }

  async function write(label: string, release: Release, session: Session): Promise<boolean> {
    return operation(label, async () => {
      await release.writeSession(client, session);
      return `Write completed: ${JSON.stringify(session)}`;
    });
  }

  async function fingerprint(label: string): Promise<void> {
    await operation(label, async () => {
      const snapshot = await client.query(stateSQL);
      result.stateFingerprint = digest(snapshot.rows[0]);
      return `Exact logical sessions-state fingerprint (column definitions, constraints and every ordered row): ${result.stateFingerprint}. No database reset occurred.`;
    }, true);
  }

  try {
    const opened = await operation('Start disposable PostgreSQL', async () => {
      db = new PGlite();
      await db.waitReady;
      const provenance = await client.query('SELECT version() AS postgres_version');
      return `Started an isolated in-memory PostgreSQL fixture: ${result.fixtureId}. ${provenance.rows[0]?.postgres_version}`;
    }, true);
    if (!opened) return result;
    initialized = await executeSQL('Load original fixture', sources['fixture.sql'], true);
    if (!initialized) return result;
    if (!await read('v1 reads original session', v1, seed, true)) return result;

    const fresh: Session = {
      id: `${definition.id}-session-${randomUUID()}`,
      userId: 'demo-user-2', role: 'editor', writeMarker: `written-by-${definition.id === 'control' ? 'v1' : 'v2'}-${randomUUID()}`,
    };
    result.markedWriteId = fresh.id;
    if (definition.id === 'control') {
      if (await write('v1 creates a marked session', v1, fresh)) await read('v1 reads its marked write', v1, fresh);
      return result;
    }

    if (!await executeSQL('Apply v2 migration', sources[`${variant}-up.sql`], true)) return result;
    const v2 = variant === 'breaking' ? breaking : compatible;
    await read('v2 reads migrated session', v2, seed);
    const written = await write('v2 creates a marked session', v2, fresh);
    if (!written) return result;
    await read('v2 reads its marked write', v2, fresh);

    if (definition.id === 'mixed') {
      await read('Old process reads migrated session', v1, seed);
      await read('Old process reads the marked v2 write', v1, fresh);
      const oldWrite = { ...fresh, id: `mixed-v1-session-${randomUUID()}`, writeMarker: `written-by-v1-${randomUUID()}` };
      if (await write('Old process writes during rollout', v1, oldWrite)) {
        await read('v2 reads a session written by the old process', v2, oldWrite);
      }
    }

    if (definition.id === 'rollback') {
      await fingerprint('Capture state with the marked v2 write before rollback');
      if (!await executeSQL('Roll back migration on the same database', sources[`${variant}-down.sql`], true)) return result;
      await read('Rolled-back v1 reads the exact marked v2 write', v1, fresh);
    }
  } catch (error) {
    append({ label: 'Rehearsal infrastructure', observation: errorText(error), outcome: 'inconclusive', durationMs: 0 });
  } finally {
    if (initialized) await fingerprint('Capture final preserved database state');
    if (db) {
      await operation('Close disposable PostgreSQL', async () => {
        await db!.close();
        return 'Database closed and its in-memory fixture released.';
      }, true);
    }
    result.outcome = result.steps.some(step => step.outcome === 'inconclusive') ? 'inconclusive'
      : result.steps.some(step => step.outcome === 'failed') ? 'failed' : 'passed';
    const failure = result.steps.find(step => step.outcome === result.outcome);
    result.explanation = result.outcome === 'passed' ? definition.expected
      : result.outcome === 'inconclusive' ? `Could not establish a complete result: ${failure?.observation ?? 'missing evidence'}`
      : `${failure?.label}: ${failure?.observation}`;
    result.durationMs = performance.now() - start;
  }
  return result;
}

export async function runRehearsal(variant: Variant): Promise<RehearsalRun> {
  assertVariant(variant);
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const scenarios: ScenarioResult[] = [];
  // Serial trials keep memory bounded, with a new database between independent trials.
  for (const definition of trialDefinitions) scenarios.push(await runTrial(definition, variant));
  const counts = scenarios.reduce((totals, scenario) => {
    totals[scenario.outcome]++;
    return totals;
  }, { passed: 0, failed: 0, inconclusive: 0 });
  return {
    id: randomUUID(), variant, startedAt, completedAt: new Date().toISOString(),
    engine: 'pglite-postgres', ...getInputDigests(variant), contract: CONTRACT, scenarios,
    summary: `${counts.passed} passed · ${counts.failed} failed · ${counts.inconclusive} inconclusive. Results come from executed SQL and session contract checks.`,
    durationMs: performance.now() - start, scope: SCOPE,
  };
}
