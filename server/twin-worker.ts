import { createInterface } from 'node:readline';
import { createTwinSession, TwinError } from '../engine/twin.js';
import { TwinApiError, validateTwinCommand, validateTwinCreate } from './twins.js';
import { LabApiError } from './lab.js';

let session: Awaited<ReturnType<typeof createTwinSession>> | undefined;
let busy = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
input.on('line', async line => {
  if (Buffer.byteLength(line) > 4096) { process.exitCode = 1; input.close(); return; }
  let message: { requestId: string; op: string; input?: unknown; command?: unknown };
  try { message = JSON.parse(line); } catch { process.exit(1); }
  if (!message || typeof message.requestId !== 'string' || busy) process.exit(1);
  busy = true;
  try {
    if (message.op === 'create' && !session) {
      session = await createTwinSession(validateTwinCreate(message.input));
      send({ requestId: message.requestId, ok: true, snapshot: await session.snapshot() });
    } else if (message.op === 'execute' && session) {
      send({ requestId: message.requestId, ok: true, snapshot: await session.execute(validateTwinCommand(message.command)) });
    } else if (message.op === 'close' && session) {
      await session.close();
      process.stdout.write(`${JSON.stringify({ requestId: message.requestId, ok: true })}\n`, () => { input.close(); process.stdin.destroy(); });
    } else throw new Error('Invalid worker operation');
  } catch (error) {
    const known = error instanceof TwinError || error instanceof TwinApiError || error instanceof LabApiError;
    send({ requestId: message.requestId, ok: false, error: {
      statusCode: known ? error.statusCode : 500, message: known ? error.message : 'Experiment worker failed.',
    } });
  } finally { busy = false; }
});
input.once('close', () => { void Promise.resolve(session?.close()).finally(() => process.exit()); });
process.once('SIGTERM', () => input.close());
