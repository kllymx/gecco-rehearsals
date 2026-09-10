import { fileURLToPath } from 'node:url';
import { getSpecimen } from '../engine/index.js';
import { createCodexAnalysis } from './ai.js';
import { createApp } from './app.js';
import { executeRehearsal } from './rehearse.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.GECCO_PORT ?? 5181);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GECCO_PORT must be between 1024 and 65535.');
const app = createApp({
  specimen: getSpecimen,
  rehearse: executeRehearsal,
  analysis: createCodexAnalysis({ cwd: root }),
  runsDirectory: fileURLToPath(new URL('../artifacts/runs', import.meta.url)),
  distDirectory: fileURLToPath(new URL('../dist', import.meta.url)),
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5180', 'http://localhost:5180'],
});
app.server.listen(port, '127.0.0.1', () => console.log(`Gecco Rehearsals: http://127.0.0.1:${port}`));
const shutdown = () => {
  app.abortAll();
  app.server.close();
  app.server.closeAllConnections();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
