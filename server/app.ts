import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { AnalysisResult, RehearsalRun, Specimen, Variant } from '../shared/contracts.js';
import type { InteractionRun, InteractionSpecimen } from '../shared/interactions.js';
import type { AnalysisService } from './ai.js';
import { ProcessFailure } from './process.js';
import { RunStore } from './store.js';
import { LabApiError, validateLabCommand, validateLabCreate, type LabManager } from './lab.js';
import { TwinApiError, validateTwinCommand, validateTwinControl, validateTwinCreate, type TwinManager } from './twins.js';
import { CloudApiError, type CloudManager } from './cloud.js';
import { ReviewApiError, type ReviewManager } from './review.js';

class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface AppOptions {
  specimen: () => Specimen;
  rehearse: (variant: Variant, signal: AbortSignal) => Promise<RehearsalRun>;
  analysis: AnalysisService;
  runsDirectory: string;
  distDirectory?: string;
  allowedOrigins?: string[];
  publicOrigin?: string;
  lab?: LabManager;
  twins?: TwinManager;
  cloud?: CloudManager;
  review?: ReviewManager;
  interactions?: {
    specimen: () => InteractionSpecimen;
    run: (variant: Variant, signal: AbortSignal) => Promise<InteractionRun>;
  };
}

function json(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Use application/json for this request.');
  }
  const limit = 1024;
  if (Number(request.headers['content-length'] || 0) > limit) throw new HttpError(413, 'Request body is too large.');
  let size = 0;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveBody, rejectBody) => {
    const cleanup = () => {
      request.removeListener('data', receive);
      request.removeListener('end', finish);
      request.removeListener('error', fail);
      clearTimeout(timer);
    };
    const fail = (error: Error) => { cleanup(); request.resume(); rejectBody(error); };
    const receive = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) fail(new HttpError(413, 'Request body is too large.'));
      else chunks.push(chunk);
    };
    const finish = () => { cleanup(); resolveBody(); };
    const timer = setTimeout(() => fail(new HttpError(408, 'Request body timed out.')), 10_000);
    request.on('data', receive);
    request.once('end', finish);
    request.once('error', fail);
  });
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body.'); }
  return body;
}

async function readVariant(request: IncomingMessage): Promise<Variant> {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
    || !('variant' in body) || (body.variant !== 'breaking' && body.variant !== 'compatible')) {
    throw new HttpError(400, 'Choose exactly one bundled variant: breaking or compatible.');
  }
  return body.variant;
}

function assertLocalRequest(request: IncomingMessage, allowedOrigins: Set<string>, publicHost?: string) {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    throw new HttpError(403, 'This demo accepts loopback requests only.');
  }
  // Checking Host also prevents a remote site from reaching the API through DNS rebinding.
  let host: URL;
  try { host = new URL(`http://${request.headers.host}`); } catch { throw new HttpError(403, 'Invalid local host.'); }
  if (host.hostname !== '127.0.0.1' && host.hostname !== 'localhost' && host.hostname !== '[::1]'
    && host.host !== publicHost) {
    throw new HttpError(403, 'This demo accepts local hosts only.');
  }
  if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
    throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'Cross-site browser requests are not allowed.');
  }
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
};

async function serveStatic(response: ServerResponse, pathname: string, directory: string): Promise<boolean> {
  let path: string;
  try {
    const root = await realpath(directory);
    const requested = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (requested !== root && !requested.startsWith(`${root}${sep}`)) return false;
    path = await realpath(pathname === '/' ? resolve(root, 'index.html') : requested);
    if (!path.startsWith(`${root}${sep}`) || !(await stat(path)).isFile()) return false;
  } catch { return false; }
  const type = contentTypes[extname(path)];
  if (!type) return false;
  const bytes = await readFile(path);
  const frameAncestors = pathname === '/preview.html' ? "'self'" : "'none'";
  response.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' https://*.proxy.daytona.works https://*.proxy.daytona.io https://*.daytonaproxy01.net; object-src 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}` });
  response.end(bytes);
  return true;
}

export function createApp(options: AppOptions) {
  const store = new RunStore(options.runsDirectory);
  const active = new Set<AbortController>();
  const occupied = { rehearse: false, analyze: false, interactions: false };
  const allowedOrigins = new Set(options.allowedOrigins ?? [
    'http://127.0.0.1:5180', 'http://localhost:5180', 'http://127.0.0.1:5181', 'http://localhost:5181',
  ]);
  let publicHost: string | undefined;
  if (options.publicOrigin) {
    const origin = new URL(options.publicOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/'
      || origin.search || origin.hash) throw new Error('Public origin must be an HTTPS origin without a path or credentials.');
    publicHost = origin.host;
    allowedOrigins.add(origin.origin);
  }
  const server = createServer(async (request, response) => {
    try {
      assertLocalRequest(request, allowedOrigins, publicHost);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, { status: 'ok', engine: 'pglite-postgres', ai: await options.analysis.health(), busy: occupied });
      } else if (request.method === 'GET' && url.pathname === '/api/specimen') {
        json(response, 200, options.specimen());
      } else if (request.method === 'GET' && url.pathname === '/api/interactions/specimen' && options.interactions) {
        json(response, 200, options.interactions.specimen());
      } else if (request.method === 'GET' && url.pathname === '/api/runs') {
        json(response, 200, await store.list());
      } else if (request.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
        const run = await store.get(url.pathname.slice('/api/runs/'.length));
        json(response, run ? 200 : 404, run ?? { error: 'Run not found.' });
      } else if (options.review && (url.pathname === '/api/review' || url.pathname === '/api/review/fix')) {
        if (request.method === 'GET' && url.pathname === '/api/review') json(response, 200, await options.review.status());
        else if (request.method === 'POST' && url.pathname === '/api/review') json(response, 202, await options.review.start(await readJson(request)));
        else if (request.method === 'POST' && url.pathname === '/api/review/fix') {
          const input = await readJson(request);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) throw new HttpError(400, 'The repair action takes no patch or command input.');
          json(response, 202, await options.review.fix());
        } else throw new HttpError(404, 'Not found.');
      } else if (options.cloud && (url.pathname === '/api/cloud' || /^\/api\/cloud\/[^/]+(?:\/control)?$/.test(url.pathname))) {
        const path = url.pathname.split('/');
        const id = path[3];
        if (request.method === 'GET' && id === 'status') json(response, 200, await options.cloud.status());
        else if (request.method === 'POST' && !id) json(response, 202, await options.cloud.create(await readJson(request)));
        else if (request.method === 'GET' && id && !path[4]) json(response, 200, await options.cloud.snapshot(id));
        else if (request.method === 'POST' && id && path[4] === 'control') json(response, 202, await options.cloud.control(id, await readJson(request)));
        else if (request.method === 'DELETE' && id && !path[4]) json(response, 202, await options.cloud.close(id));
        else throw new HttpError(404, 'Not found.');
      } else if (options.twins && (url.pathname === '/api/twins' || /^\/api\/twins\/[^/]+(?:\/(?:commands|control))?$/.test(url.pathname))) {
        const path = url.pathname.split('/');
        const id = path[3];
        // Accepted work belongs to the server. Reloading a preview does not cancel it.
        if (request.method === 'POST' && url.pathname === '/api/twins') {
          json(response, 201, await options.twins.create(validateTwinCreate(await readJson(request))));
        } else if (request.method === 'GET' && id && !path[4]) {
          json(response, 200, await options.twins.snapshot(id));
        } else if (request.method === 'POST' && path[4] === 'commands') {
          json(response, 200, await options.twins.execute(id, validateTwinCommand(await readJson(request))));
        } else if (request.method === 'POST' && path[4] === 'control') {
          json(response, 200, await options.twins.control(id, validateTwinControl(await readJson(request))));
        } else if (request.method === 'DELETE' && id && !path[4]) {
          await options.twins.close(id);
          if (!response.destroyed) { response.writeHead(204); response.end(); }
        } else throw new HttpError(404, 'Not found.');
      } else if (options.lab && (url.pathname === '/api/lab' || /^\/api\/lab\/[^/]+(?:\/commands)?$/.test(url.pathname))) {
        const path = url.pathname.split('/');
        const id = path[3];
        const isCreate = request.method === 'POST' && url.pathname === '/api/lab';
        const isCommand = request.method === 'POST' && path[4] === 'commands';
        const isSnapshot = request.method === 'GET' && !!id && !path[4];
        const isDelete = request.method === 'DELETE' && !!id && !path[4];
        if (!isCreate && !isCommand && !isSnapshot && !isDelete) throw new HttpError(404, 'Not found.');
        const input = isCreate ? validateLabCreate(await readJson(request)) : undefined;
        const command = isCommand ? validateLabCommand(await readJson(request)) : undefined;
        const controller = new AbortController();
        active.add(controller);
        const disconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', disconnect);
        try {
          if (isDelete) {
            await options.lab.close(id);
            if (!response.destroyed) { response.writeHead(204); response.end(); }
          } else {
            const snapshot = input ? await options.lab.create(input, controller.signal)
              : command ? await options.lab.execute(id, command, controller.signal)
              : await options.lab.snapshot(id, controller.signal);
            json(response, isCreate ? 201 : 200, snapshot);
          }
        } finally {
          active.delete(controller);
          response.removeListener('close', disconnect);
        }
      } else if (request.method === 'POST' && (url.pathname === '/api/rehearse' || url.pathname === '/api/analyze'
        || (url.pathname === '/api/interactions' && options.interactions))) {
        const variant = await readVariant(request);
        const operation = url.pathname === '/api/rehearse' ? 'rehearse' : url.pathname === '/api/interactions' ? 'interactions' : 'analyze';
        const label = operation === 'rehearse' ? 'rehearsal' : operation === 'interactions' ? 'interaction check' : 'live analysis';
        if (occupied[operation]) throw new HttpError(429, `A ${label} is already running. Try again after it completes.`);
        occupied[operation] = true;
        const controller = new AbortController();
        active.add(controller);
        const disconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', disconnect);
        try {
          let result: RehearsalRun | AnalysisResult | InteractionRun;
          if (operation === 'rehearse') {
            const run = await options.rehearse(variant, controller.signal);
            await store.save(run);
            result = run;
          } else if (operation === 'interactions') result = await options.interactions!.run(variant, controller.signal);
          else result = await options.analysis.analyze(options.specimen(), variant, controller.signal);
          json(response, 200, result);
        } finally {
          active.delete(controller);
          occupied[operation] = false;
          response.removeListener('close', disconnect);
        }
      } else if (request.method === 'GET' && !url.pathname.startsWith('/api/') && options.distDirectory
        && await serveStatic(response, url.pathname, options.distDirectory)) {
        // Served only built assets from dist, never repository source or artifacts.
      } else json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof LabApiError || error instanceof TwinApiError || error instanceof CloudApiError || error instanceof ReviewApiError ? error.statusCode
        : error instanceof ProcessFailure && error.kind === 'timeout' ? 504 : 500;
      json(response, status, { error: error instanceof HttpError || error instanceof LabApiError || error instanceof TwinApiError || error instanceof CloudApiError || error instanceof ReviewApiError ? error.message
        : error instanceof ProcessFailure && error.kind === 'timeout' ? 'The execution exceeded its time limit; no execution verdict was recorded.'
        : 'The operation could not complete; no execution verdict was recorded.' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 32;
  return { server, abortAll: () => {
    for (const controller of active) controller.abort();
    options.review?.shutdown();
    options.lab?.closeAll();
    options.twins?.closeAll();
    return options.cloud?.closeAll();
  } };
}
