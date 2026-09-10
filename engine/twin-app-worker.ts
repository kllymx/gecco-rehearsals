import * as v1 from './specimen/v1.js';
import * as breaking from './specimen/v2-breaking.js';
import * as compatible from './specimen/v2-compatible.js';
import { SessionContractError, type Session, type SqlClient } from './specimen/types.js';

const releaseName = process.argv[2];
const variant = process.argv[3];
if (!process.send || (releaseName !== 'v1' && releaseName !== 'v2')
  || (variant !== 'breaking' && variant !== 'compatible')) throw new Error('Invalid trusted app configuration');
const release = releaseName === 'v1' ? v1 : variant === 'breaking' ? breaking : compatible;
let activeOperation: string | undefined;
let sequence = 0;
const queries = new Map<string, { resolve: (result: { rows: Record<string, unknown>[] }) => void; reject: (error: Error) => void }>();

function send(message: unknown): void { process.send?.(message as object); }
const client: SqlClient = {
  query(query, parameters) {
    if (!activeOperation) return Promise.reject(new Error('No active app operation'));
    const queryId = `${process.pid}-${++sequence}`;
    return new Promise((resolve, reject) => {
      queries.set(queryId, { resolve, reject });
      send({ type: 'query', operationId: activeOperation, queryId, query, parameters });
    });
  },
};

async function businessAction(operation: string, expected: Session, note?: string) {
  if (operation === 'write') {
    await release.writeSession(client, expected);
    return {};
  }
  const session = await release.readSession(client, expected.id);
  if (session.id !== expected.id || session.userId !== expected.userId || session.role !== expected.role || session.writeMarker !== expected.writeMarker) {
    throw new SessionContractError('The app decoded a different session identity or write marker than the session that was stored.');
  }
  // This is the app's business boundary: a note cannot be read or saved unless
  // the selected session is decoded and its full identity is validated first.
  const result = operation === 'save'
    ? await client.query('UPDATE notes SET body = $2 WHERE user_id = $1 RETURNING body', [session.userId, note])
    : await client.query('SELECT body FROM notes WHERE user_id = $1', [session.userId]);
  if (typeof result.rows[0]?.body !== 'string') throw new SessionContractError('No note belongs to this decoded session identity.');
  return { session, note: result.rows[0].body };
}

process.on('message', async (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  const data = message as Record<string, unknown>;
  if (data.type === 'query-result') {
    const query = queries.get(String(data.queryId));
    if (!query) return;
    queries.delete(String(data.queryId));
    if (data.error) {
      const failure = data.error as { message: string; code?: string };
      query.reject(Object.assign(new Error(failure.message), { code: failure.code }));
    } else query.resolve({ rows: data.rows as Record<string, unknown>[] });
  } else if (data.type === 'run') {
    if (activeOperation || !['read', 'save', 'write'].includes(String(data.operation))) {
      send({ type: 'result', operationId: data.operationId, error: { message: 'Invalid app operation', compatibility: false } });
      return;
    }
    activeOperation = String(data.operationId);
    try {
      const result = await businessAction(String(data.operation), data.expected as Session, data.note as string | undefined);
      send({ type: 'result', operationId: activeOperation, result });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      send({ type: 'result', operationId: activeOperation, error: {
        message: error instanceof Error ? error.message : String(error), code,
        compatibility: error instanceof SessionContractError || code === '42703',
      } });
    } finally { activeOperation = undefined; }
  }
});
process.on('disconnect', () => process.exit(0));
send({ type: 'ready', pid: process.pid, release: releaseName });
