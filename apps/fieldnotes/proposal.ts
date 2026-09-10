import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Release } from '../../engine/specimen/types.js';
import type { ProposalIdentity } from './protocol.js';

export const byteDigest = (source: string): string => `sha256:${createHash('sha256').update(source).digest('hex')}`;

// This path is supplied by the trusted runner, never by an HTTP request. The
// runner checks out the exact proposed commit and constrains its editable files.
export async function loadProposal(checkout: string) {
  if (!isAbsolute(checkout)) throw new Error('The proposed checkout must be an absolute path.');
  const directory = join(checkout, 'apps/fieldnotes');
  const names = ['release.json', 'release.ts', 'deployment/up.sql', 'deployment/down.sql'] as const;
  const files = await Promise.all(names.map(async path => {
    const source = await readFile(join(directory, path), 'utf8');
    if (!source.trim() || Buffer.byteLength(source) > 64_000) throw new Error(`Invalid proposed ${path}.`);
    return { path, source };
  }));
  const manifest = JSON.parse(files[0].source) as { release?: unknown };
  if (manifest.release !== 'v2-breaking' && manifest.release !== 'v2-compatible') throw new Error('The proposed checkout must declare a v2 release.');
  const implementation = await import(pathToFileURL(join(directory, 'release.ts')).href) as Release;
  if (typeof implementation.readSession !== 'function' || typeof implementation.writeSession !== 'function') throw new Error('The proposed release must export its reader and writer.');
  const identity: ProposalIdentity = {
    release: manifest.release, releaseDigest: byteDigest(files[1].source),
    upDigest: byteDigest(files[2].source), downDigest: byteDigest(files[3].source),
    digest: byteDigest(JSON.stringify(files)),
  };
  return { identity, implementation, files, up: files[2].source, down: files[3].source };
}
