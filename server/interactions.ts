import { fileURLToPath } from 'node:url';
import type { Variant } from '../shared/contracts.js';
import type { InteractionRun } from '../shared/interactions.js';
import { runProcess } from './process.js';

/** Executes only the bundled changes, with a finite lifetime and disconnect cancellation. */
export async function executeInteractions(variant: Variant, signal?: AbortSignal): Promise<InteractionRun> {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const { stdout } = await runProcess(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./interactions-worker.ts', import.meta.url)), variant],
    { cwd, timeoutMs: 10_000, maxOutputBytes: 1_000_000, signal });
  return JSON.parse(stdout) as InteractionRun;
}
