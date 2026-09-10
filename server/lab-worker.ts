import { createInterface } from 'node:readline';
import { createLabSession, LabError } from '../engine/lab.js';
import { LabApiError, validateLabCommand, validateLabCreate } from './lab.js';

let session: Awaited<ReturnType<typeof createLabSession>> | undefined;
let busy = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
input.on('line', async line => {
  if (Buffer.byteLength(line) > 2048) { process.exitCode = 1; input.close(); return; }
  let message: { requestId: string; op: string; input?: unknown; command?: unknown };
  try { message = JSON.parse(line); } catch { process.exit(1); }
  if (!message || typeof message.requestId !== 'string' || busy) { process.exit(1); }
  busy = true;
  try {
    if (message.op === 'create' && !session) {
      session = await createLabSession(validateLabCreate(message.input));
      send({ requestId: message.requestId, ok: true, snapshot: await session.snapshot() });
    } else if (message.op === 'snapshot' && session) {
      send({ requestId: message.requestId, ok: true, snapshot: await session.snapshot() });
    } else if (message.op === 'execute' && session) {
      send({ requestId: message.requestId, ok: true, snapshot: await session.execute(validateLabCommand(message.command)) });
    } else if (message.op === 'close' && session) {
      await session.close();
      process.stdout.write(`${JSON.stringify({ requestId: message.requestId, ok: true })}\n`, () => {
        input.close();
        process.stdin.destroy();
      });
    } else throw new Error('Invalid worker operation');
  } catch (error) {
    const statusCode = error instanceof LabError || error instanceof LabApiError ? error.statusCode : 500;
    send({ requestId: message.requestId, ok: false, error: { statusCode,
      message: error instanceof LabError || error instanceof LabApiError ? error.message : 'Lab worker failed.' } });
  } finally { busy = false; }
});
input.once('close', () => { void Promise.resolve(session?.close()).finally(() => process.exit()); });
process.once('SIGTERM', () => { input.close(); });
