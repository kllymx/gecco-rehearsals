import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApplication, failure, HttpError } from './app.js';
import type { ReleaseName } from './protocol.js';

const token = process.env.GECCO_ADMIN_TOKEN;
if (!token || token.length < 32) throw new Error('Set GECCO_ADMIN_TOKEN to a random secret of at least 32 characters.');
const databaseURL = process.env.GECCO_DATABASE_URL;
if (!databaseURL) throw new Error('Set GECCO_DATABASE_URL to the sandbox native PostgreSQL database.');
const release = (process.env.GECCO_RELEASE ?? 'v1') as ReleaseName;
const application = await createApplication({ release, databaseURL,
  stateFile: process.env.GECCO_STATE_FILE ?? fileURLToPath(new URL('./.state/config.json', import.meta.url)) });
const publicPort = Number(process.env.PORT ?? 3000);
const adminPort = Number(process.env.GECCO_ADMIN_PORT ?? 4000);
const host = process.env.GECCO_HOST ?? '0.0.0.0';
const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/style.css', 'style.css', 'text/css; charset=utf-8'],
].map(async ([path, file, type]) => [path, { type, body: await readFile(new URL(`./web/${file}`, import.meta.url)) }] as const)));

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<any> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send application/json.');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 24_000) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'Send a JSON object.'); }
}
function authorized(request: IncomingMessage): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function handle(admin: boolean) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fieldnotes.local');
      if (admin) {
        if (!authorized(request)) { json(response, 401, { error: 'Unauthorized.' }); return; }
        if (request.method === 'GET' && url.pathname === '/admin/state') { json(response, 200, application.snapshot()); return; }
        if (request.method === 'GET' && url.pathname === '/admin/rows') { json(response, 200, await application.rows()); return; }
        if (request.method === 'POST') {
          const input = await body(request);
          const route = url.pathname;
          const result = route === '/admin/initialize' ? await application.initialize(input)
            : route === '/admin/config' ? await application.configure(input)
              : route === '/admin/migrate' ? await application.migrate(input)
                : route === '/admin/write-session' ? await application.writeSession(input)
                  : route === '/admin/read' ? await application.read()
                    : route === '/admin/note' ? await application.note(input, true)
                      : route === '/admin/query' ? await application.gateway(input) : undefined;
          if (result !== undefined) { json(response, 200, result); return; }
        }
      } else {
        if (request.method === 'GET' && assets.has(url.pathname)) {
          const asset = assets.get(url.pathname)!;
          response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'" });
          response.end(asset.body); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/state') { json(response, 200, application.snapshot()); return; }
        if (request.method === 'GET' && url.pathname === '/api/workspace') { json(response, 200, await application.read()); return; }
        if (request.method === 'POST' && url.pathname === '/api/note') { json(response, 200, await application.note(await body(request))); return; }
        if (request.method === 'GET' && url.pathname === '/health') { json(response, 200, { processReady: true, release, instanceId: application.snapshot().instanceId }); return; }
      }
      json(response, 404, { error: 'Not found.' });
    } catch (error) { json(response, error instanceof HttpError ? error.statusCode : 503, { error: error instanceof Error ? error.message : 'Request failed.', ...(error instanceof HttpError ? {} : { outcome: 'inconclusive', detail: failure(error) }) }); }
  };
}
const publicServer = createServer(handle(false));
const adminServer = createServer(handle(true));
for (const server of [publicServer, adminServer]) { server.requestTimeout = 20_000; server.headersTimeout = 10_000; }
try {
  await Promise.all([
    new Promise<void>((resolve, reject) => { publicServer.once('error', reject); publicServer.listen(publicPort, host, resolve); }),
    new Promise<void>((resolve, reject) => { adminServer.once('error', reject); adminServer.listen(adminPort, host, resolve); }),
  ]);
} catch (error) { publicServer.close(); adminServer.close(); await application.close(); throw error; }
console.log(JSON.stringify({ event: 'fieldnotes_ready', pid: process.pid, release, instanceId: application.snapshot().instanceId, publicPort, adminPort }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 20_000); timer.unref();
  await Promise.all([publicServer, adminServer].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); })));
  await application.close(); clearTimeout(timer);
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
