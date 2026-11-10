import { readFile, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sourceRequestSchema, sourceResultSchema } from '@hivemagnus/embermend-contracts';
import { redact } from '@hivemagnus/embermend-integrations';
import { safePath } from './index.js';
const line = await createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]().next(); if (line.done) throw new Error('Source request required');
const { request } = z.object({ request: sourceRequestSchema }).strict().parse(JSON.parse(line.value));
const files = []; const excluded = []; let bytes = 0;
for (const path of request.paths) {
  if (!safePath(path) || path.split('/').includes('.git')) throw new Error('Source path outside worker boundary');
  let cursor = '/source'; let allowed = true;
  for (const segment of path.split('/')) { cursor = join(cursor, segment); const stat = await lstat(cursor).catch(() => null); if (!stat || stat.isSymbolicLink()) { allowed = false; break; } }
  if (!allowed) { excluded.push({ path, reason: 'unavailable-or-symbolic-link' }); continue; }
  const stat = await lstat(join('/source', path)); if (!stat.isFile() || stat.nlink !== 1 || bytes + stat.size > 256000) { excluded.push({ path, reason: 'source-budget-or-file-kind' }); continue; }
  const source = await readFile(join('/source', path), 'utf8'); const content = redact(source); bytes += stat.size;
  files.push({ path, content, sourceDigest: createHash('sha256').update(source).digest('hex'), redacted: content !== source });
}
const result = sourceResultSchema.parse({ repositoryId: request.repositoryId, commit: request.commit, files, coverage: { status: excluded.length ? 'partial' : 'complete', requested: request.paths, examined: files.map(file => file.path), excluded, failures: [], mode: 'incremental', observedAt: new Date().toISOString() } });
process.stdout.write(JSON.stringify({ kind: 'result', result }) + '\n'); process.stdin.destroy();
