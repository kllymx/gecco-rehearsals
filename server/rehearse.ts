import { fileURLToPath } from 'node:url';
import type { RehearsalRun, Variant } from '../shared/contracts.js';
import { runProcess } from './process.js';

/** A disposable process gives each rehearsal a finite lifetime, including stalled WASM. */
export async function executeRehearsal(variant: Variant, signal?: AbortSignal): Promise<RehearsalRun> {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const { stdout } = await runProcess(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./rehearse-worker.ts', import.meta.url)), variant],
    { cwd, timeoutMs: 45_000, maxOutputBytes: 2_000_000, signal });
  return JSON.parse(stdout) as RehearsalRun;
}
