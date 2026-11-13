import type { ScanRequest } from '@hivemagnus/embermend-contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readScanSources } from '@hivemagnus/embermend-scanner';
import { scope, commit, later } from './fixtures.js';
const request = (): ScanRequest => ({ repositoryId: 'fixture-repository', providerId: 'fixture-provider', commit, applicationId: 'fixture-app', scope, branch: 'main', pullRequest: null, includedPaths: ['apps/selected'], excludedPaths: [], profile: 'typescript-security.v1', mode: 'full' as const, workerTargetId: 'fixture-node', operationId: 'fixture-scan', deadline: later(), cancellationId: 'fixture-cancellation', maxFiles: 10, maxBytes: 100, sourcePolicy: { providerRef: 'fixture-model', allowRemoteModel: false, allowRepositoryExecution: false } });
test('filesystem reader applies monorepo scope before IO and byte budget admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'embermend-source-'));
  try {
    await mkdir(join(root, 'apps/selected'), { recursive: true }); await mkdir(join(root, 'apps/other'));
    await writeFile(join(root, 'a-unrelated.ts'), 'x'.repeat(90)); await writeFile(join(root, 'apps/other/unrelated.ts'), 'x'.repeat(90));
    await writeFile(join(root, 'apps/selected/index.ts'), 'export const selected = "' + 'x'.repeat(30) + '";');
    const result = await readScanSources(root, request());
    assert.deepEqual(result.files.map(file => file.path), ['apps/selected/index.ts']);
    assert.equal(result.omitted.some(item => item.reason === 'resource-budget'), false);
    assert.deepEqual(result.omitted.map(item => item.path), ['a-unrelated.ts', 'apps/other']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('reader retains exclusions, hardlinks, symlinks, unsupported files and exhausted scope budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'embermend-source-'));
  try {
    const selected = join(root, 'apps/selected'); await mkdir(selected, { recursive: true });
    await writeFile(join(root, 'private.ts'), 'fixture outside scope');
    await symlink(join(root, 'private.ts'), join(selected, 'symlink.ts'));
    await writeFile(join(selected, 'hardlink.ts'), 'fixture'); await link(join(selected, 'hardlink.ts'), join(selected, 'hardlink-copy.ts'));
    await writeFile(join(selected, 'README.md'), 'fixture'); await writeFile(join(selected, 'excluded.ts'), 'fixture');
    await writeFile(join(selected, 'oversized.ts'), 'x'.repeat(101));
    const result = await readScanSources(root, { ...request(), excludedPaths: ['apps/selected/excluded.ts'] });
    assert.equal(result.files.length, 0);
    for (const reason of ['outside-application-scope', 'symbolic-link-not-followed', 'source-hardlink-or-changed-kind', 'unsupported-language', 'explicit-exclusion', 'resource-budget']) assert.equal(result.omitted.some(item => item.reason === reason), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a file that is not UTF-8 is omitted without failing the rest of the scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'embermend-source-'));
  try {
    const selected = join(root, 'apps/selected'); await mkdir(selected, { recursive: true });
    await writeFile(join(selected, 'legacy.js'), Buffer.from([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await writeFile(join(selected, 'marked.ts'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export const a = 1;')]));
    await writeFile(join(selected, 'plain.ts'), 'export const b = "é";');
    const result = await readScanSources(root, request());
    assert.deepEqual(result.files.map(file => file.path).sort(), ['apps/selected/marked.ts', 'apps/selected/plain.ts']);
    assert.deepEqual(result.omitted, [{ path: 'apps/selected/legacy.js', reason: 'unsupported-encoding' }]);
    // The byte-order mark is kept, so the digest still identifies the bytes on disk.
    const marked = result.files.find(file => file.path === 'apps/selected/marked.ts');
    assert.equal(marked?.content.charCodeAt(0), 0xfeff);
    assert.equal(marked?.sha256, createHash('sha256').update(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export const a = 1;')])).digest('hex'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
