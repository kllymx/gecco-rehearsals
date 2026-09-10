import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import type { ReviewManager } from '../server/review.js';
import type { ReviewState } from '../shared/review.js';

test('review HTTP actions preserve accepted work and reject injected patch data or foreign origins', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gecco-review-http-'));
  const state: ReviewState = { stage: 'waiting', defaultPrUrl: 'https://github.com/kllymx/gecco-rehearsals/pull/1',
    message: 'Ready', updatedAt: new Date().toISOString() };
  let starts = 0, fixes = 0, shutdowns = 0;
  const review: ReviewManager = {
    status: async () => state,
    start: async input => { assert.equal((input as { prUrl: string }).prUrl, state.defaultPrUrl); starts++; return state; },
    fix: async () => { fixes++; return state; },
    shutdown: () => { shutdowns++; },
  };
  const app = createApp({ review, runsDirectory: dir,
    specimen: () => { throw new Error('unused'); }, rehearse: async () => { throw new Error('unused'); },
    analysis: { health: async () => ({ available: false, provider: 'test', model: null }), analyze: async () => { throw new Error('unused'); } } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/review')).status, 200);
  assert.equal((await post('/api/review/fix', {}, { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post('/api/review/fix', { patch: 'injected' })).status, 400);
  assert.equal((await post('/api/review/fix', null)).status, 400);
  assert.equal((await post('/api/review/fix', [])).status, 400);
  assert.equal(fixes, 0);
  assert.equal((await post('/api/review', { prUrl: state.defaultPrUrl, label: 'Demo' })).status, 202);
  assert.equal((await post('/api/review/fix', {})).status, 202);
  assert.equal((await fetch(base + '/api/review')).status, 200);
  assert.deepEqual({ starts, fixes, shutdowns }, { starts: 1, fixes: 1, shutdowns: 0 });
  await app.abortAll();
  assert.equal(shutdowns, 1);
});
