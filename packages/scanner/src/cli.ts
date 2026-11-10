import { readdir, lstat, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { scanRequestSchema } from '@hivemagnus/embermend-contracts';
import { scan, type SourceFile } from './index.js';
import type { Model } from '@hivemagnus/embermend-integrations';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const first = await lines.next(); if (first.done) throw new Error('Scanner request required');
const input = z.object({ request: scanRequestSchema, modelRef: z.string(), localModel: z.boolean() }).strict().parse(JSON.parse(first.value));
const files: SourceFile[] = []; const omitted: { path: string; reason: string }[] = []; let count = 0; let bytes = 0;
async function walk(relative: string): Promise<void> {
  const directory = join('/source', relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = relative ? relative + '/' + entry.name : entry.name;
    if (['.git', 'node_modules'].includes(entry.name)) { omitted.push({ path, reason: 'repository-metadata-or-installed-dependencies' }); continue; }
    if (++count > 20000) throw new Error('SOURCE_ENTRY_BUDGET_EXCEEDED');
    if (entry.isSymbolicLink()) { omitted.push({ path, reason: 'symbolic-link-not-followed' }); continue; }
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!entry.isFile()) { omitted.push({ path, reason: 'unsupported-file-kind' }); continue; }
    const info = await lstat(join('/source', path));
    if (info.nlink !== 1 || info.size > 1024 * 1024 || bytes + info.size > input.request.maxBytes) { omitted.push({ path, reason: 'source-budget-or-hardlink' }); continue; }
    const content = await readFile(join('/source', path), 'utf8'); bytes += info.size;
    files.push({ path, content, sha256: createHash('sha256').update(content).digest('hex') });
  }
}
await walk('');
const model: Model = { ref: input.modelRef, local: input.localModel, analyze: async (system, content, signal) => {
  signal.throwIfAborted(); const id = randomUUID(); process.stdout.write(JSON.stringify({ kind: 'model-request', id, system, content }) + '\n');
  const line = await lines.next(); if (line.done) throw new Error('MODEL_BROKER_DISCONNECTED');
  const response = z.object({ id: z.string(), result: z.unknown() }).strict().parse(JSON.parse(line.value));
  if (response.id !== id) throw new Error('MODEL_BROKER_IDENTITY_MISMATCH'); return response.result;
} };
const stop = new AbortController(); process.once('SIGTERM', () => stop.abort());
const result = await scan(input.request, files, model, stop.signal);
result.coverage.excluded.push(...omitted);
if (omitted.some(item => item.reason !== 'repository-metadata-or-installed-dependencies')) { result.coverage.status = 'partial'; result.state = 'partial'; }
process.stdout.write(JSON.stringify({ kind: 'result', result }) + '\n');
process.exitCode = 0;
process.stdin.destroy();
