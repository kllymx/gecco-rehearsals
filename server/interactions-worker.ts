import { runInteractions } from '../engine/interactions/index.js';

const variant = process.argv[2];
if (variant !== 'breaking' && variant !== 'compatible') throw new Error('Unknown bundled interaction variant');
const run = await runInteractions(variant);
process.stdout.write(JSON.stringify(run));
