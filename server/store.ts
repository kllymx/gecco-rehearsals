import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RehearsalRun } from '../shared/contracts.js';

export const validRunId = (id: string) => /^[a-zA-Z0-9_-]{8,100}$/.test(id);

export class RunStore {
  constructor(private readonly directory: string) {}
  async save(run: RehearsalRun): Promise<void> {
    if (!validRunId(run.id)) throw new Error('Invalid run ID');
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${run.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  }
  async get(id: string): Promise<RehearsalRun | null> {
    if (!validRunId(id)) return null;
    try {
      const path = join(this.directory, `${id}.json`);
      if ((await stat(path)).size > 2_000_000) return null;
      const run = JSON.parse(await readFile(path, 'utf8')) as RehearsalRun;
      return run.id === id && Array.isArray(run.scenarios) && typeof run.completedAt === 'string' ? run : null;
    } catch { return null; }
  }
  async list(): Promise<RehearsalRun[]> {
    let files: string[];
    try { files = await readdir(this.directory); } catch { return []; }
    const runs = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => this.get(file.slice(0, -5))));
    return runs.filter((run): run is RehearsalRun => run !== null)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 100);
  }
}
