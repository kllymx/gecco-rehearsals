import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runRehearsal } from './index.js';
import type { Variant } from '../shared/contracts.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pnpm rehearse [breaking|compatible] [--json] [--output path.json]\n\nExit codes: 0 all passed, 1 observed failure, 2 inconclusive or invalid invocation.');
    return;
  }
  let variant: Variant = 'breaking';
  let json = false;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') json = true;
    else if (argument === '--output') {
      output = args[++index];
      if (!output || output.startsWith('--')) throw new Error('--output requires a file path');
    } else if (argument === '--variant') {
      const next = args[++index];
      if (next !== 'breaking' && next !== 'compatible') throw new Error('--variant requires breaking or compatible');
      variant = next;
    } else if (argument === 'breaking' || argument === 'compatible') variant = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  const run = await runRehearsal(variant);
  const serialized = `${JSON.stringify(run, null, 2)}\n`;
  if (output) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized);
  }
  if (json) process.stdout.write(serialized);
  else {
    console.log(`Gecco Rehearsals · ${variant}\n${run.summary}\n`);
    for (const scenario of run.scenarios) {
      console.log(`${scenario.outcome.toUpperCase().padEnd(12)} ${scenario.title}\n  ${scenario.explanation}\n  ${scenario.stateFingerprint}`);
    }
    console.log(`\nSource: ${run.sourceDigest}\nFixture: ${run.fixtureDigest}\n${run.scope}`);
    if (output) console.log(`Evidence saved: ${resolve(output)}`);
  }
  process.exitCode = run.scenarios.some(scenario => scenario.outcome === 'inconclusive') ? 2
    : run.scenarios.some(scenario => scenario.outcome === 'failed') ? 1 : 0;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
