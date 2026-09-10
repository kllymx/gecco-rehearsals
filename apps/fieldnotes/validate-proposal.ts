import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import * as previous from '../../engine/specimen/v1.js';
import { createApplication, HttpError, type Application } from './app.js';
import { loadProposal } from './proposal.js';
import type { OperationResult, ProposalIdentity } from './protocol.js';

export interface ValidationReport {
  schemaVersion: 1; scope: 'trusted_native_postgresql_proposal_contract'; proposal: ProposalIdentity | null;
  outcome: 'passed' | 'failed' | 'inconclusive'; checks: { name: string; passed: boolean }[];
  operations: { name: string; result: OperationResult }[]; error?: string;
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(done => child.once('close', () => done()));
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited; clearTimeout(timer);
}
async function port(): Promise<number> {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return value;
}

// Always invoke this file from the trusted coordinator checkout. The proposed
// checkout supplies only the allowed release/migration inputs, never the oracle.
export async function validateProposal(checkout: string): Promise<ValidationReport> {
  const report: ValidationReport = { schemaVersion: 1, scope: 'trusted_native_postgresql_proposal_contract', proposal: null, outcome: 'inconclusive', checks: [], operations: [] };
  const root = await mkdtemp(join(tmpdir(), 'fieldnotes-proposal-'));
  const apps: Application[] = []; let postgres: ChildProcess | undefined;
  const gateway = createServer(); let listening = false;
  const check = (name: string, passed: boolean) => { report.checks.push({ name, passed }); };
  const observe = (name: string, result: OperationResult) => { report.operations.push({ name, result }); return result; };
  try {
    const proposed = await loadProposal(checkout); report.proposal = proposed.identity;
    const initialized = spawnSync('initdb', ['-D', join(root, 'postgres'), '--auth=trust', '--no-locale', '--encoding=UTF8'], { encoding: 'utf8', timeout: 20_000 });
    if (initialized.status !== 0) throw new Error(`Native PostgreSQL initdb failed: ${initialized.error?.message ?? initialized.stderr}`);
    const socket = join(root, 'socket'); await mkdir(socket);
    const pgPort = await port();
    postgres = spawn('postgres', ['-D', join(root, 'postgres'), '-h', '127.0.0.1', '-p', String(pgPort), '-k', socket], { stdio: 'ignore' });
    let spawnError: Error | undefined; postgres.on('error', error => { spawnError = error; });
    const connection = `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${pgPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      const client = new pg.Client({ connectionString: `${connection}/postgres`, connectionTimeoutMillis: 200 });
      try { await client.connect(); await client.query('SELECT 1'); ready = true; break; }
      catch { await new Promise(done => setTimeout(done, 50)); }
      finally { await client.end(); }
    }
    if (!ready) throw new Error('Native PostgreSQL did not become ready.');
    const controller = new pg.Client({ connectionString: `${connection}/postgres` });
    try { await controller.connect(); await controller.query('CREATE DATABASE fieldnotes_left'); await controller.query('CREATE DATABASE fieldnotes_right'); }
    finally { await controller.end(); }
    const left = await createApplication({ release: 'v1', implementation: previous, proposedCheckout: checkout, databaseURL: `${connection}/fieldnotes_left`, stateFile: join(root, 'left.json') }); apps.push(left);
    let right = await createApplication({ release: proposed.identity.release, implementation: proposed.implementation, proposedCheckout: checkout, databaseURL: `${connection}/fieldnotes_right`, stateFile: join(root, 'right.json') }); apps.push(right);
    let mismatchedCatalogRejected = false;
    try { await left.gateway({ statement: `${proposed.identity.release}.write`, statementDigest: 'sha256:wrong', parameters: ['unwritten-session', '{}', '{}'] }); }
    catch (error) { mismatchedCatalogRejected = error instanceof HttpError && error.statusCode === 409; }
    check('gateway rejects a mismatched proposed statement digest before SQL', mismatchedCatalogRejected);
    const gatewayToken = randomUUID();
    gateway.on('request', (request, response) => { void (async () => {
      try {
        if (request.url !== '/admin/query' || request.method !== 'POST' || request.headers.authorization !== `Bearer ${gatewayToken}`) { response.writeHead(404); response.end(); return; }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await left.gateway(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
      } catch (error) { response.writeHead(error instanceof HttpError ? error.statusCode : 503); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Gateway failed.' })); }
    })(); });
    await new Promise<void>(done => gateway.listen(0, '127.0.0.1', done)); listening = true;
    const gatewayURL = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const initialNote = '- [x] Draft release notes\n- [ ] Test the upgrade\n- [ ] Announce launch';
    const savedNote = initialNote.replace('- [ ] Test', '- [x] Test');
    const fixture = { label: `Zoë O'Connor ${randomUUID().slice(0, 8)}`, sessionId: randomUUID(), writeMarker: randomUUID(), note: initialNote };
    const expectedSession = (result: OperationResult, marker: string, note: string) => result.outcome === 'passed'
      && result.snapshot.observation?.userId === fixture.label && result.snapshot.observation?.writeMarker === marker
      && result.snapshot.observation?.role === (marker === fixture.writeMarker ? 'viewer' : 'editor')
      && result.snapshot.observation?.note === note;
    for (const [name, app] of [['left', left], ['right', right]] as const) {
      const result = observe(`initialize-${name}`, await app.initialize(fixture));
      if (result.outcome !== 'passed') throw new Error(`Could not initialize ${name}.`);
    }
    check('baseline databases are independent', left.snapshot().database.id !== right.snapshot().database.id);
    const upRight = observe('migrate-right', await right.migrate({ direction: 'up', variant: 'breaking' }));
    if (upRight.outcome !== 'passed') throw new Error('Proposed migration could not set up the candidate baseline.');
    check('previous baseline reads the original identity', expectedSession(observe('baseline-left', await left.read()), fixture.writeMarker, initialNote));
    check('proposed baseline reads the same identity', expectedSession(observe('baseline-right', await right.read()), fixture.writeMarker, initialNote));
    check('proposed standalone checklist saves', expectedSession(observe('standalone-save', await right.note({ commandId: randomUUID(), note: savedNote })), fixture.writeMarker, savedNote));
    check('standalone save leaves previous database untouched', expectedSession(observe('standalone-left-control', await left.read()), fixture.writeMarker, initialNote));
    const upLeft = observe('migrate-shared', await left.migrate({ direction: 'up', variant: 'breaking' }));
    if (upLeft.outcome !== 'passed') throw new Error('Proposed migration could not set up the shared database.');
    const routed = observe('route-right', await right.configure({ database: { kind: 'gateway', url: gatewayURL, token: gatewayToken, databaseId: left.snapshot().database.id } }));
    if (routed.outcome !== 'passed') throw new Error('Could not route proposed app to the shared database.');
    check('mixed previous app reads original identity', expectedSession(observe('mixed-left', await left.read()), fixture.writeMarker, initialNote));
    check('mixed proposed app reads original identity', expectedSession(observe('mixed-right', await right.read()), fixture.writeMarker, initialNote));
    const next = { id: randomUUID(), userId: fixture.label, role: 'editor', writeMarker: randomUUID() };
    const write = observe('write-new', await right.writeSession({ session: next }));
    if (write.outcome !== 'passed') throw new Error('Proposed app could not write a new shared session.');
    await left.configure({ selectedSessionId: next.id });
    check('new session is read by the previous app', expectedSession(observe('new-left', await left.read()), next.writeMarker, initialNote));
    check('new session is read by the proposed app', expectedSession(observe('new-right', await right.read()), next.writeMarker, initialNote));
    check('new session can save a checklist', expectedSession(observe('shared-save', await right.note({ commandId: randomUUID(), note: savedNote })), next.writeMarker, savedNote));
    check('previous app sees the actual shared save', expectedSession(observe('shared-save-left', await left.read()), next.writeMarker, savedNote));
    const down = observe('rollback-schema', await left.migrate({ direction: 'down', variant: 'breaking' }));
    if (down.outcome !== 'passed') throw new Error('Proposed rollback could not restore the old schema.');
    await right.close(); apps.splice(apps.indexOf(right), 1);
    right = await createApplication({ release: 'v1', implementation: previous, proposedCheckout: checkout, databaseURL: `${connection}/fieldnotes_right`, stateFile: join(root, 'right.json') }); apps.push(right);
    for (const [name, app] of [['left', left], ['right', right]] as const) {
      const result = observe(`rollback-${name}`, await app.read());
      check(`rollback ${name} retains the exact new session and saved checklist`, expectedSession(result, next.writeMarker, savedNote) && result.snapshot.selectedSessionId === next.id && result.snapshot.database.id === left.snapshot().database.id);
    }
    report.outcome = report.operations.some(({ result }) => result.outcome === 'inconclusive') ? 'inconclusive'
      : report.checks.every(entry => entry.passed) ? 'passed' : 'failed';
  } catch (error) { report.error = error instanceof Error ? error.message : 'Proposal validation could not complete.'; }
  finally {
    if (listening) await new Promise<void>(done => { gateway.close(() => done()); gateway.closeAllConnections(); });
    for (const app of apps) await app.close();
    await stop(postgres); await rm(root, { recursive: true, force: true });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checkout = process.argv[2];
  if (!checkout) { console.error('Usage: node --import tsx TRUSTED/apps/fieldnotes/validate-proposal.ts CANDIDATE_CHECKOUT'); process.exitCode = 2; }
  else { const report = await validateProposal(resolve(checkout)); console.log(JSON.stringify(report)); process.exitCode = report.outcome === 'passed' ? 0 : 1; }
}
