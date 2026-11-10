import { constants } from 'node:fs';
import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { scanRequestSchema, type ScanRequest } from '@hivemagnus/embermend-contracts';
import { matchesPath, safePath, type SourceFile } from './index.js';
export interface SourceRead { files: SourceFile[]; omitted: { path: string; reason: string }[] }
/** Called on the immutable read-only checkout. Scope is applied before file IO and byte admission, including directory traversal. */
export async function readScanSources(root: string, raw: ScanRequest): Promise<SourceRead> {
  const request = scanRequestSchema.parse(raw); if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('CANONICAL_SOURCE_ROOT_REQUIRED');
  const files: SourceFile[] = []; const omitted: SourceRead['omitted'] = []; let count = 0; let bytes = 0;
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (!safePath(path)) throw new Error('INVALID_SOURCE_PATH');
      if (['.git', 'node_modules'].includes(entry.name)) { omitted.push({ path, reason: 'repository-metadata-or-installed-dependencies' }); continue; }
      if (++count > 20000) throw new Error('SOURCE_ENTRY_BUDGET_EXCEEDED');
      const selected = request.includedPaths.some(prefix => matchesPath(path, prefix) || entry.isDirectory() && matchesPath(prefix, path));
      if (!selected) { omitted.push({ path, reason: 'outside-application-scope' }); continue; }
      if (request.excludedPaths.some(prefix => matchesPath(path, prefix))) { omitted.push({ path, reason: 'explicit-exclusion' }); continue; }
      if (entry.isSymbolicLink()) { omitted.push({ path, reason: 'symbolic-link-not-followed' }); continue; }
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) { omitted.push({ path, reason: 'unsupported-file-kind' }); continue; }
      if (!/\.[cm]?[jt]sx?$/.test(path)) { omitted.push({ path, reason: 'unsupported-language' }); continue; }
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) { omitted.push({ path, reason: 'source-hardlink-or-changed-kind' }); continue; }
      if (files.length >= request.maxFiles || info.size > 1024 * 1024 || bytes + info.size > request.maxBytes) { omitted.push({ path, reason: 'resource-budget' }); continue; }
      const fd = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try { const opened = await fd.stat(); if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('SOURCE_CHANGED_DURING_OPEN'); content = await fd.readFile('utf8'); } finally { await fd.close(); }
      const actualBytes = Buffer.byteLength(content);
      if (actualBytes !== info.size || bytes + actualBytes > request.maxBytes) throw new Error('SOURCE_CHANGED_DURING_READ');
      bytes += actualBytes; files.push({ path, content, sha256: createHash('sha256').update(content).digest('hex') });
    }
  }
  await walk(''); return { files, omitted };
}
