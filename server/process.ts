import { spawn } from 'node:child_process';

export class ProcessFailure extends Error {
  constructor(public readonly kind: 'unavailable' | 'timeout' | 'cancelled' | 'output-limit' | 'exit', public readonly details = '',
    public readonly capture?: { stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null; complete: boolean }) {
    super(kind);
  }
}

/** No shell, finite output, deadline, and process-group cleanup on disconnect/shutdown. */
export function runProcess(command: string, args: string[], options: {
  cwd: string;
  input?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) return Promise.reject(new ProcessFailure('cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let failure: ProcessFailure | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already exited. */ }
    };
    const stop = (reason: ProcessFailure) => {
      if (failure) return;
      failure = reason;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop(new ProcessFailure('timeout')), options.timeoutMs);
    const onAbort = () => stop(new ProcessFailure('cancelled'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const receive = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxOutputBytes ?? 256_000)) {
        stop(new ProcessFailure('output-limit'));
        return;
      }
      if (kind === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => receive('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => receive('stderr', chunk));
    child.stdin.on('error', () => { /* An exiting child may close stdin early. */ });
    child.once('error', () => { failure ??= new ProcessFailure('unavailable'); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (failure) kill('SIGKILL');
      options.signal?.removeEventListener('abort', onAbort);
      const capture = { stdout, stderr, exitCode: code, signal, complete: !failure && code !== null && signal === null };
      if (failure) reject(new ProcessFailure(failure.kind, failure.details, capture));
      else if (code !== 0) reject(new ProcessFailure('exit', stderr || stdout, capture));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}
