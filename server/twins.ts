import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { TWIN_JOURNEY, type TwinAction, type TwinCommand, type TwinCreateInput, type TwinSnapshot } from '../shared/twin.js';
import { validateLabCreate } from './lab.js';

export class TwinApiError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}
export interface TwinManager {
  create(input: TwinCreateInput): Promise<TwinSnapshot>;
  snapshot(id: string): Promise<TwinSnapshot>;
  execute(id: string, command: TwinCommand): Promise<TwinSnapshot>;
  control(id: string, action: 'play' | 'pause'): Promise<TwinSnapshot>;
  close(id: string): Promise<void>;
  closeAll(): void;
}
export function validateTwinCreate(input: unknown): TwinCreateInput { return validateLabCreate(input); }
export function validateTwinCommand(input: unknown): TwinCommand {
  const command = input as Record<string, unknown> | null;
  const required = ['commandId', 'expectedRevision', 'action'];
  const actions: TwinAction[] = ['read-both', 'read-left', 'read-right', 'save-left', 'save-right', 'deploy', 'write-new', 'rollback'];
  if (!command || typeof command !== 'object' || Array.isArray(command)
    || required.some(key => !Object.hasOwn(command, key))
    || Object.keys(command).some(key => ![...required, 'note'].includes(key))
    || typeof command.commandId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(command.commandId)
    || !Number.isSafeInteger(command.expectedRevision) || (command.expectedRevision as number) < 0
    || !actions.includes(command.action as TwinAction)
    || ('note' in command && (typeof command.note !== 'string' || [...command.note].length > 280
      || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(command.note)))) {
    throw new TwinApiError(400, 'Use a supported action, a valid command ID and revision, and an optional note of at most 280 characters.');
  }
  if ('note' in command && command.action !== 'save-left' && command.action !== 'save-right') {
    throw new TwinApiError(400, 'Notes can only be submitted with save-left or save-right.');
  }
  if ((command.action === 'save-left' || command.action === 'save-right') && typeof command.note !== 'string') {
    throw new TwinApiError(400, 'Saving a note requires its text.');
  }
  return command as unknown as TwinCommand;
}
export function validateTwinControl(input: unknown): 'play' | 'pause' {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
    || !('action' in input) || (input.action !== 'play' && input.action !== 'pause')) {
    throw new TwinApiError(400, 'Choose exactly one control action: play or pause.');
  }
  return input.action;
}

export type TwinWorkerRequest = { op: 'create'; input: TwinCreateInput } | { op: 'execute'; command: TwinCommand } | { op: 'close' };
export interface TwinWorker {
  request(message: TwinWorkerRequest): Promise<TwinSnapshot | undefined>;
  stop(): void;
}

/** The coordinator and its app children share one killable process group. */
function spawnTwinWorker(onFailure: () => void, timeoutMs: number): TwinWorker {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./twin-worker.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let stopped = false;
  let pending: { id: string; resolve: (snapshot: TwinSnapshot | undefined) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const decoder = new StringDecoder('utf8');
  let buffer = '', bytes = 0, stderrBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* Already gone. */ }
  };
  const stop = (error = new TwinApiError(503, 'The experiment worker stopped. Create new twins to continue.')) => {
    if (stopped) return;
    stopped = true;
    const waiting = pending; pending = undefined;
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(error); }
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 500);
    killTimer.unref();
    onFailure();
  };
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    buffer += decoder.write(chunk);
    if (bytes > 64_000_000 || Buffer.byteLength(buffer) > 2_000_000) { stop(); return; }
    let newline: number;
    while (!stopped && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let reply: { requestId?: string; ok?: boolean; snapshot?: TwinSnapshot; error?: { statusCode?: number; message?: string } };
      try { reply = JSON.parse(line); } catch { stop(); return; }
      if (!reply || typeof reply !== 'object' || !pending || reply.requestId !== pending.id || typeof reply.ok !== 'boolean') { stop(); return; }
      const waiting = pending; pending = undefined; clearTimeout(waiting.timer);
      if (reply.ok) waiting.resolve(reply.snapshot);
      else if (reply.error?.statusCode === 400 || reply.error?.statusCode === 409) {
        waiting.reject(new TwinApiError(reply.error.statusCode, reply.error.message?.slice(0, 300) || 'The command is not valid in this state.'));
      } else {
        waiting.reject(new TwinApiError(reply.error?.statusCode === 410 ? 404 : 503, 'The experiment could not complete. Create new twins to continue.'));
        stop();
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64_000) stop(); });
  child.stdin.on('error', () => stop());
  child.once('error', () => stop());
  child.once('close', () => { stop(); if (killTimer) clearTimeout(killTimer); kill('SIGKILL'); });
  return {
    stop,
    request(message) {
      if (stopped) return Promise.reject(new TwinApiError(404, 'Experiment not found or expired.'));
      if (pending) return Promise.reject(new TwinApiError(409, 'An experiment operation is already running.'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => stop(new TwinApiError(504, 'The operation exceeded its time limit. Both app processes have been closed.')), timeoutMs);
        pending = { id, resolve, reject, timer };
        child.stdin.write(`${JSON.stringify({ ...message, requestId: id })}\n`);
      });
    },
  };
}

interface Entry {
  worker: TwinWorker;
  state?: TwinSnapshot;
  createdAt: number;
  lastUsedAt: number;
  busy: boolean;
  diverged: boolean;
  pauseRequested: boolean;
  automation: TwinSnapshot['automation'];
  timer?: ReturnType<typeof setTimeout>;
}
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

export function createTwinManager(options: {
  maxSessions?: number; idleTtlMs?: number; maxLifetimeMs?: number; requestTimeoutMs?: number; dwellMs?: number;
  workerFactory?: (onFailure: () => void, timeoutMs: number) => TwinWorker;
  now?: () => number;
} = {}): TwinManager {
  const entries = new Map<string, Entry>();
  const now = options.now ?? Date.now;
  const idleTtl = options.idleTtlMs ?? 15 * 60_000, maxLife = options.maxLifetimeMs ?? 30 * 60_000;
  let closed = false;
  const remove = (id: string) => {
    const entry = entries.get(id); entries.delete(id);
    if (entry?.timer) clearTimeout(entry.timer);
    entry?.worker.stop();
  };
  const prune = () => {
    for (const [id, entry] of entries) {
      if (now() - entry.createdAt >= maxLife || (!entry.busy && entry.automation.status !== 'running' && now() - entry.lastUsedAt >= idleTtl)) remove(id);
    }
  };
  const reaper = setInterval(prune, Math.min(10_000, idleTtl, maxLife)); reaper.unref();
  const get = (id: string): Entry => {
    prune();
    const entry = validId(id) ? entries.get(id) : undefined;
    if (!entry) throw new TwinApiError(404, 'Experiment not found or expired.');
    return entry;
  };
  const present = (id: string, entry: Entry): TwinSnapshot => {
    if (!entry.state) throw new TwinApiError(409, 'The two apps are still starting.');
    return structuredClone({ ...entry.state, id, busy: entry.busy, automation: entry.automation });
  };
  async function request(id: string, entry: Entry, message: TwinWorkerRequest): Promise<TwinSnapshot | undefined> {
    if (entry.busy) throw new TwinApiError(409, 'An experiment operation is already running.');
    entry.busy = true;
    try {
      const state = await entry.worker.request(message);
      if (message.op !== 'close') {
        if (!state || !Number.isSafeInteger(state.revision) || !Array.isArray(state.events) || !Array.isArray(state.allowedActions)) {
          throw new TwinApiError(503, 'The experiment returned an invalid state.');
        }
        // Retrying an earlier idempotent command must not rewind the latest cached state.
        if (!entry.state || state.revision >= entry.state.revision) entry.state = state;
      }
      return state;
    } catch (error) {
      if (!(error instanceof TwinApiError) || ![400, 409].includes(error.statusCode)) remove(id);
      throw error;
    } finally { entry.busy = false; entry.lastUsedAt = now(); }
  }
  async function runStep(id: string, entry: Entry): Promise<void> {
    if (entries.get(id) !== entry || entry.automation.status !== 'running' || entry.busy) return;
    const action = TWIN_JOURNEY[entry.automation.stepIndex];
    if (!action) { entry.automation = { ...entry.automation, status: 'completed', currentAction: undefined }; return; }
    if (!entry.state?.allowedActions.includes(action)) {
      entry.automation = { ...entry.automation, status: 'stopped', currentAction: undefined };
      entry.diverged = true;
      return;
    }
    entry.automation.currentAction = action;
    try {
      await request(id, entry, { op: 'execute', command: { commandId: randomUUID(), expectedRevision: entry.state.revision, action } });
      if (entries.get(id) !== entry) return;
      entry.automation.stepIndex++;
      entry.automation.currentAction = undefined;
      if (entry.state?.events.at(-1)?.outcome === 'inconclusive') entry.automation.status = 'stopped';
      else if (entry.automation.stepIndex === TWIN_JOURNEY.length) entry.automation.status = 'completed';
      else if (entry.pauseRequested) entry.automation.status = 'paused';
      else {
        // Hold completed evidence for the audience; no operation is represented as still executing.
        const dwell = options.dwellMs ?? (action === 'read-both' && entry.state?.events.at(-1)?.outcome === 'failed' ? 4000 : 2500);
        entry.timer = setTimeout(() => { entry.timer = undefined; void runStep(id, entry); }, dwell);
        entry.timer.unref();
      }
    } catch {
      if (entries.get(id) === entry) entry.automation = { ...entry.automation, status: 'stopped', currentAction: undefined };
    }
  }
  return {
    async create(input) {
      input = validateTwinCreate(input); prune();
      if (closed) throw new TwinApiError(503, 'The experiment server is shutting down.');
      if (entries.size >= (options.maxSessions ?? 2)) throw new TwinApiError(429, 'Two paired experiments are already open. Close one before starting another.');
      const id = randomUUID();
      const worker = (options.workerFactory ?? spawnTwinWorker)(() => {
        const entry = entries.get(id); if (entry?.timer) clearTimeout(entry.timer); entries.delete(id);
      }, options.requestTimeoutMs ?? 25_000);
      const entry: Entry = { worker, createdAt: now(), lastUsedAt: now(), busy: false, diverged: false, pauseRequested: false,
        automation: { status: 'idle', stepIndex: 0, totalSteps: TWIN_JOURNEY.length } };
      entries.set(id, entry);
      try { await request(id, entry, { op: 'create', input }); return present(id, entry); }
      catch (error) { remove(id); throw error; }
    },
    async snapshot(id) { const entry = get(id); entry.lastUsedAt = now(); return present(id, entry); },
    async execute(id, command) {
      command = validateTwinCommand(command);
      const entry = get(id);
      if (entry.automation.status === 'running' || entry.busy) throw new TwinApiError(409, 'Pause the experiment and wait for the current operation before using manual controls.');
      if (entry.automation.status === 'stopped') throw new TwinApiError(409, 'This journey stopped before completing. Reset the twins to continue.');
      const priorRevision = entry.state?.revision;
      const result = await request(id, entry, { op: 'execute', command });
      if (entry.state?.revision !== priorRevision && ['deploy', 'write-new', 'rollback'].includes(command.action)) {
        entry.diverged = true;
        entry.automation.status = 'paused';
      }
      // The command reply preserves idempotency; polling still sees the newest cached revision.
      return structuredClone({ ...result!, id, busy: entry.busy, automation: entry.automation });
    },
    async control(id, action) {
      if (action !== 'play' && action !== 'pause') throw new TwinApiError(400, 'Choose play or pause.');
      const entry = get(id); entry.lastUsedAt = now();
      if (action === 'pause') {
        entry.pauseRequested = true;
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
        if (entry.automation.status === 'running' && !entry.busy) entry.automation.status = 'paused';
        return present(id, entry);
      }
      if (entry.automation.status === 'running') { entry.pauseRequested = false; return present(id, entry); }
      if (entry.automation.status === 'completed') return present(id, entry);
      if (entry.busy) throw new TwinApiError(409, 'Wait for the current operation before starting the journey.');
      if (entry.diverged || entry.automation.status === 'stopped') throw new TwinApiError(409, 'Manual actions changed this experiment. Reset the twins to run the automatic journey.');
      entry.pauseRequested = false;
      entry.automation.status = 'running';
      void runStep(id, entry);
      return present(id, entry);
    },
    async close(id) {
      const entry = get(id);
      if (entry.busy || entry.automation.status === 'running') { remove(id); return; }
      try { await request(id, entry, { op: 'close' }); } finally { remove(id); }
    },
    closeAll() { closed = true; clearInterval(reaper); for (const id of entries.keys()) remove(id); },
  };
}
