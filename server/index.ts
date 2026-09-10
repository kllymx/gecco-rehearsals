import { fileURLToPath } from 'node:url';
import { getSpecimen } from '../engine/index.js';
import { getInteractionSpecimen } from '../engine/interactions/index.js';
import { createCodexAnalysis } from './ai.js';
import { createApp } from './app.js';
import { executeRehearsal } from './rehearse.js';
import { executeInteractions } from './interactions.js';
import { createLabManager } from './lab.js';
import { createTwinManager } from './twins.js';
import { Daytona } from '@daytona/sdk';
import { createDaytonaProvider, daytonaClient } from './daytona-provider.js';
import { createCloudManager } from './cloud.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.GECCO_PORT ?? 5181);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GECCO_PORT must be between 1024 and 65535.');
const app = createApp({
  specimen: getSpecimen,
  rehearse: executeRehearsal,
  interactions: { specimen: getInteractionSpecimen, run: executeInteractions },
  lab: createLabManager(),
  twins: createTwinManager(),
  cloud: createCloudManager({
    provider: process.env.DAYTONA_API_KEY ? createDaytonaProvider({
      client: daytonaClient(new Daytona({ apiKey: process.env.DAYTONA_API_KEY,
        apiUrl: process.env.DAYTONA_API_URL ?? 'https://app.daytona.io/api',
        target: process.env.DAYTONA_TARGET ?? 'us', requestTimeoutMs: 30_000, otelEnabled: false })),
      stateDirectory: `${root}/artifacts/daytona/provider`, namespace: 'gecco-hackathon-20260910',
      image: 'node:22-bookworm', user: 'root', limits: { operationSeconds: 300, createSeconds: 300 },
    }) : undefined,
    stateDirectory: `${root}/artifacts/daytona/rehearsals`,
    sourceRef: process.env.GECCO_CLOUD_BASE_REF ?? process.env.GECCO_CLOUD_SOURCE_REF ?? '',
    ...(process.env.GECCO_CLOUD_BASE_REF ? { sourceRefs: {
      base: process.env.GECCO_CLOUD_BASE_REF,
      breaking: process.env.GECCO_CLOUD_BREAKING_REF ?? '',
      compatible: process.env.GECCO_CLOUD_COMPATIBLE_REF ?? '',
    } } : {}),
  }),
  analysis: createCodexAnalysis({ cwd: root }),
  runsDirectory: fileURLToPath(new URL('../artifacts/runs', import.meta.url)),
  distDirectory: fileURLToPath(new URL('../dist', import.meta.url)),
  publicOrigin: process.env.GECCO_PUBLIC_ORIGIN,
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5180', 'http://localhost:5180'],
});
app.server.listen(port, '127.0.0.1', () => console.log(`Gecco Rehearsals: http://127.0.0.1:${port}`));
const shutdown = async () => {
  app.server.close();
  app.server.closeAllConnections();
  await app.abortAll();
};
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
