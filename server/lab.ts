import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { LabCommand, LabCreateInput, LabSnapshot } from '../shared/lab.js';

export class LabApiError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

export interface LabManager {
  create(input: LabCreateInput, signal?: AbortSignal): Promise<LabSnapshot>;
  snapshot(id: string, signal?: AbortSignal): Promise<LabSnapshot>;
  execute(id: string, command: LabCommand, signal?: AbortSignal): Promise<LabSnapshot>;
  close(id: string): Promise<void>;
  closeAll(): void;
}

function exactObject(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function validateLabCreate(value: unknown): LabCreateInput {
  if (!exactObject(value, ['variant', 'label']) || (value.variant !== 'breaking' && value.variant !== 'compatible')
    || typeof value.label !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value.label)) {
    throw new LabApiError(400, 'Choose a bundled variant and a label containing 1 to 48 characters without control characters.');
  }
  const label = value.label.trim();
  if (Array.from(label).length < 1 || Array.from(label).length > 48) {
    throw new LabApiError(400, 'The label must contain 1 to 48 characters after trimming.');
  }
  return { variant: value.variant, label };
}

export function validateLabCommand(value: unknown): LabCommand {
  if (!exactObject(value, ['commandId', 'expectedRevision', 'action'])
    || typeof value.commandId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value.commandId)
    || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0
    || !['read-old', 'migrate', 'write-new', 'read-new', 'rollback'].includes(value.action as string)) {
    throw new LabApiError(400, 'Use a supported action, a command ID of 8 to 100 letters, digits, hyphens or underscores, and a nonnegative integer revision.');
  }
  return value as unknown as LabCommand;
}

const validLabId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export type LabWorkerRequest = { op: 'create'; input: LabCreateInput } | { op: 'snapshot' } | { op: 'execute'; command: LabCommand } | { op: 'close' };
export interface LabWorker {
  request(message: LabWorkerRequest, signal?: AbortSignal): Promise<LabSnapshot | undefined>;
  stop(): void;
}

/** One NDJSON request at a time. Lost replies invalidate the whole database session. */
function spawnLabWorker(onFailure: () => void, timeoutMs: number): LabWorker {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./lab-worker.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let stopped = false;
  let pending: { id: string; resolve: (snapshot: LabSnapshot | undefined) => void; reject: (error: Error) => void; cleanup: () => void } | undefined;
  let buffer = '';
  let bytes = 0;
  let stderrBytes = 0;
  const decoder = new StringDecoder('utf8');
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* Process is already gone. */ }
  };
  const stop = (reason = new LabApiError(503, 'The lab worker stopped. Create a new lab to continue.')) => {
    if (stopped) return;
    stopped = true;
    const waiting = pending;
    pending = undefined;
    waiting?.cleanup();
    waiting?.reject(reason);
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 500);
    killTimer.unref();
    onFailure();
  };
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    buffer += decoder.write(chunk);
    if (bytes > 32_000_000 || Buffer.byteLength(buffer) > 1_000_000) {
      stop(new LabApiError(503, 'The lab exceeded its output limit. Create a new lab to continue.'));
      return;
    }
    let newline: number;
    while (!stopped && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let reply: { requestId?: string; ok?: boolean; snapshot?: LabSnapshot; error?: { statusCode?: number; message?: string } };
      try { reply = JSON.parse(line); } catch { stop(); return; }
      if (!reply || typeof reply !== 'object' || !pending || reply.requestId !== pending.id || typeof reply.ok !== 'boolean') { stop(); return; }
      const waiting = pending;
      pending = undefined;
      waiting.cleanup();
      if (reply.ok) waiting.resolve(reply.snapshot);
      else {
        const status = reply.error?.statusCode;
        if (status === 400 || status === 409 || status === 410) {
          waiting.reject(new LabApiError(status === 410 ? 404 : status, reply.error?.message?.slice(0, 300) || 'This lab command cannot run in the current state.'));
          if (status === 410) stop();
        } else {
          waiting.reject(new LabApiError(503, 'The lab execution did not complete. Create a new lab to continue.'));
          stop();
        }
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64_000) stop(); });
  child.stdin.on('error', () => stop());
  child.once('error', () => stop());
  child.once('close', () => {
    stop();
    if (killTimer) clearTimeout(killTimer);
    kill('SIGKILL');
  });
  return {
    stop,
    request(message, signal) {
      if (stopped) return Promise.reject(new LabApiError(404, 'Lab not found or expired.'));
      if (pending) return Promise.reject(new LabApiError(409, 'A request is already running in this lab.'));
      if (signal?.aborted) { stop(); return Promise.reject(new LabApiError(503, 'The lab request was cancelled.')); }
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const onAbort = () => stop(new LabApiError(503, 'The lab request was cancelled. Its database has been closed.'));
        const timer = setTimeout(() => stop(new LabApiError(504, 'The lab request exceeded its time limit. Its database has been closed.')), timeoutMs);
        pending = { id, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdin.write(`${JSON.stringify({ ...message, requestId: id })}\n`);
      });
    },
  };
}

export function createLabManager(options: {
  maxSessions?: number;
  idleTtlMs?: number;
  maxLifetimeMs?: number;
  requestTimeoutMs?: number;
  /** Test injection only; never supplied by an HTTP request. */
  workerFactory?: (onFailure: () => void, timeoutMs: number) => LabWorker;
  now?: () => number;
} = {}): LabManager {
  const entries = new Map<string, { worker: LabWorker; createdAt: number; lastUsedAt: number; busy: boolean }>();
  const now = options.now ?? Date.now;
  const idleTtl = options.idleTtlMs ?? 15 * 60_000;
  const maxLifetime = options.maxLifetimeMs ?? 30 * 60_000;
  let closed = false;
  const remove = (id: string) => {
    const entry = entries.get(id);
    entries.delete(id);
    entry?.worker.stop();
  };
  const prune = () => {
    for (const [id, entry] of entries) {
      if (now() - entry.createdAt >= maxLifetime || (!entry.busy && now() - entry.lastUsedAt >= idleTtl)) remove(id);
    }
  };
  const reaper = setInterval(prune, Math.min(10_000, idleTtl, maxLifetime));
  reaper.unref();
  async function request(id: string, message: LabWorkerRequest, signal?: AbortSignal): Promise<LabSnapshot | undefined> {
    prune();
    const entry = validLabId(id) ? entries.get(id) : undefined;
    if (!entry) throw new LabApiError(404, 'Lab not found or expired.');
    if (entry.busy) throw new LabApiError(409, 'A request is already running in this lab.');
    entry.busy = true;
    try {
      const snapshot = await entry.worker.request(message, signal);
      if (message.op !== 'close' && (!snapshot || typeof snapshot.revision !== 'number' || !Array.isArray(snapshot.events))) {
        remove(id);
        throw new LabApiError(503, 'The lab returned an invalid response. Create a new lab to continue.');
      }
      return snapshot ? { ...snapshot, id } : undefined;
    } catch (error) {
      if (!(error instanceof LabApiError) || ![400, 409].includes(error.statusCode)) remove(id);
      throw error;
    } finally {
      entry.busy = false;
      entry.lastUsedAt = now();
    }
  }
  return {
    async create(input, signal) {
      input = validateLabCreate(input);
      prune();
      if (closed) throw new LabApiError(503, 'The lab server is shutting down.');
      if (entries.size >= (options.maxSessions ?? 3)) throw new LabApiError(429, 'Three labs are already open. Close a lab or wait for an idle lab to expire.');
      const id = randomUUID();
      const worker = (options.workerFactory ?? spawnLabWorker)(() => entries.delete(id), options.requestTimeoutMs ?? 20_000);
      // Reserve capacity before awaiting database initialization.
      entries.set(id, { worker, createdAt: now(), lastUsedAt: now(), busy: false });
      try { return (await request(id, { op: 'create', input }, signal))!; }
      catch (error) { remove(id); throw error; }
    },
    async snapshot(id, signal) { return (await request(id, { op: 'snapshot' }, signal))!; },
    async execute(id, command, signal) { return (await request(id, { op: 'execute', command: validateLabCommand(command) }, signal))!; },
    async close(id) { await request(id, { op: 'close' }); remove(id); },
    closeAll() {
      closed = true;
      clearInterval(reaper);
      for (const id of entries.keys()) remove(id);
    },
  };
}
