import { runRehearsal } from '../engine/index.js';

const variant = process.argv[2];
if (variant !== 'breaking' && variant !== 'compatible') throw new Error('Unknown bundled specimen variant');
const run = await runRehearsal(variant);
process.stdout.write(JSON.stringify(run));
