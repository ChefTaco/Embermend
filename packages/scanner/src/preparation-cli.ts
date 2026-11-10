import { constants } from 'node:fs';
import { open, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { preparationSchema, preparationResultSchema, canonicalJson } from '@hivemagnus/embermend-contracts';
import { redact } from '@hivemagnus/embermend-integrations';
import { safePath, matchesPath } from './index.js';
const exec = promisify(execFile);
const line = await createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]().next();
if (line.done) throw new Error('Preparation request required');
const input = z.object({ request: preparationSchema, validationArgv: z.array(z.string().max(1000)).min(1).max(64) }).strict().parse(JSON.parse(line.value));
const request = input.request;
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
for (const edit of request.edits) {
  if (!safePath(edit.path) || edit.path.split('/').includes('.git') || !request.includedPaths.some(path => matchesPath(edit.path, path)) || request.excludedPaths.some(path => matchesPath(edit.path, path))) throw new Error('Patch outside source scope');
  const path = join('/source', edit.path);
  const segments = edit.path.split('/'); segments.pop(); let parent = '/source';
  for (const segment of segments) { parent = join(parent, segment); const info = await lstat(parent).catch(() => null); if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Source parent is not a regular directory'); if (!info) await mkdir(parent, { mode: 0o755 }); }
  const existing = await lstat(path).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('Source path is not a regular file');
  const previous = existing ? await readFile(path, 'utf8') : null;
  if ((previous === null ? null : hash(previous)) !== edit.beforeDigest) throw new Error('Source precondition changed');
  if (edit.content === null) { if (existing) await unlink(path); continue; }
  await mkdir(dirname(path), { recursive: true });
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try { await fd.writeFile(edit.content); await fd.sync(); } finally { await fd.close(); }
}
const binary = input.validationArgv[0]; if (!binary || !['/usr/local/bin/node', '/usr/local/bin/npm'].includes(binary)) throw new Error('Reviewed validation executable required');
let validated = false; let output = ''; let error = '';
try { const result = await exec(binary, input.validationArgv.slice(1), { cwd: '/source', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' }, timeout: Math.max(1, Math.min(300000, Date.parse(request.deadline) - Date.now())), maxBuffer: 65536 }); output = redact(result.stdout); error = redact(result.stderr); validated = true; }
catch { error = 'Approved isolated validation failed or exceeded its resource budget'; }
for (const edit of request.edits) {
  const actual = await readFile(join('/source', edit.path), 'utf8').catch(() => null);
  if (actual !== edit.content) throw new Error('Validation changed the reviewed patch');
}
const result = preparationResultSchema.parse({ preparationId: request.id, baseCommit: request.baseCommit, patchDigest: hash(canonicalJson(request.edits)), validated, edits: request.edits, validationEvidence: { method: request.validationProfileId, output, error, limitation: 'Passing repository validation does not establish independent security verification or runtime remediation' }, coverage: { status: validated ? 'complete' : 'failed', requested: request.edits.map(edit => edit.path), examined: request.edits.map(edit => edit.path), excluded: [], failures: validated ? [] : ['validation-failed'], mode: 'incremental', observedAt: new Date().toISOString() } });
process.stdout.write(JSON.stringify({ kind: 'result', result }) + '\n');
process.stdin.destroy();
