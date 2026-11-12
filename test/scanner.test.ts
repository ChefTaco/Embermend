import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { scan, safePath, indexSource, scannerBrokerResult } from '@hivemagnus/embermend-scanner';
import type { ScanRequest } from '@hivemagnus/embermend-contracts';
import type { Model } from '@hivemagnus/embermend-integrations';
import { sourceFile, scope, commit, later } from './fixtures.js';
const request = (): ScanRequest => ({ repositoryId: 'fixture-repository', providerId: 'fixture-provider', commit, applicationId: 'fixture-app', scope, branch: 'main', pullRequest: null, includedPaths: ['apps/api'], excludedPaths: [], profile: 'typescript-security.v1', mode: 'full', workerTargetId: 'fixture-node', operationId: 'fixture-scan', deadline: later(), cancellationId: 'fixture-cancellation', maxFiles: 100, maxBytes: 100000, sourcePolicy: { providerRef: 'fixture-model', allowRemoteModel: false, allowRepositoryExecution: false } });
const model: Model = { ref: 'fixture-model', local: true, analyze: async () => ({ candidates: [{ path: 'apps/api/server.ts', line: 1, symbol: 'route', weakness: 'injection', title: 'Input concatenated into command', evidence: 'Request input reaches exec without an argument boundary', assumptions: ['request is externally reachable'], severity: 'high', confidence: 0.9 }] }) };
test('scanner parses real syntax and records actual model analysis as candidates', async () => {
  const file = sourceFile('apps/api/server.ts', 'export function route(input: string) { exec("echo " + input); }');
  assert.equal(indexSource(file).hints[0]?.expression, 'exec');
  const result = await scan(request(), [file], model, new AbortController().signal);
  assert.equal(result.candidates[0]?.validation, 'candidate'); assert.equal(result.coverage.status, 'complete'); assert.deepEqual(result.coverage.examined, [file.path]);
});
test('scanner reports unsupported and excluded files as partial coverage', async () => {
  const result = await scan(request(), [sourceFile('apps/api/model.py', 'print("fixture")')], model, new AbortController().signal);
  assert.equal(result.state, 'partial'); assert.equal(result.coverage.examined.length, 0); assert.equal(result.coverage.excluded[0]?.reason, 'unsupported-language');
});
test('repository content cannot expand application scope or source disclosure policy', async () => {
  for (const path of ['../private.ts', '/etc/private.ts', 'app/../../private.ts', 'app\\private.ts']) assert.equal(safePath(path), false);
  await assert.rejects(scan(request(), [sourceFile('../private.ts', 'export {}')], model, new AbortController().signal), /INVALID_SOURCE/);
  await assert.rejects(scan(request(), [], { ...model, local: false }, new AbortController().signal), /DISCLOSURE/);
});
test('malformed, failed, and truncated model responses cannot produce clean coverage', async () => {
  const result = await scan(request(), [sourceFile('apps/api/server.ts', 'export function route() {}')], { ...model, analyze: async () => ({ notCandidates: [] }) }, new AbortController().signal);
  assert.equal(result.coverage.status, 'partial'); assert.equal(result.coverage.failures.length, 1);
});
test('semantic finding anchors survive supported file renames and line movement', async () => {
  const a = await scan(request(), [sourceFile('apps/api/server.ts', 'export function route(input: string) { exec(input); }')], model, new AbortController().signal);
  const b = await scan(request(), [sourceFile('apps/api/renamed.ts', '\nexport function route(input: string) { exec(input); }')], { ...model, analyze: async () => ({ candidates: [{ path: 'apps/api/renamed.ts', line: 2, symbol: 'route', weakness: 'injection', title: 'Input command', evidence: 'Input reaches exec', assumptions: [], severity: 'high', confidence: 0.9 }] }) }, new AbortController().signal);
  assert.equal(a.candidates[0]?.fingerprint, b.candidates[0]?.fingerprint);
});
test('distinct defects sharing a classification and function remain separate findings', async () => {
  const file = sourceFile('apps/api/server.ts', 'export function route(input: string) {\n exec("echo " + input);\n exec("printf " + input);\n}');
  const custom: Model = { ...model, analyze: async () => ({ candidates: [2, 3].map(line => ({ path: file.path, line, symbol: 'route', weakness: 'injection', title: 'Input reaches a shell', evidence: `Independent sink at line ${line}`, assumptions: [], severity: 'high', confidence: 0.9 })) }) };
  const result = await scan(request(), [file], custom, new AbortController().signal); assert.equal(result.candidates.length, 2); assert.notEqual(result.candidates[0]?.fingerprint, result.candidates[1]?.fingerprint);
});

test('explicit broker failure retains partial coverage and refuses cross-request replies', async () => {
  assert.throws(() => scannerBrokerResult({ id: 'different', result: { candidates: [] } }, 'expected'), /IDENTITY_MISMATCH/);
  assert.throws(() => scannerBrokerResult({ id: 'expected', error: 'provider-secret-detail' }, 'expected'));
  const result = await scan(request(), [sourceFile('apps/api/server.ts', 'export function route() {}')], { ...model, analyze: async () => scannerBrokerResult({ id: 'expected', error: 'MODEL_BROKER_UNAVAILABLE' }, 'expected') }, new AbortController().signal);
  assert.equal(result.coverage.status, 'partial'); assert.deepEqual(result.coverage.examined, []); assert.deepEqual(result.coverage.failures, ['analysis-failed:apps/api/server.ts']);
});


test('identical semantic anchors in different files remain distinct and require review', async () => {
  const content = 'export function route(input: string) { exec(input); }';
  const files = ['apps/api/server.ts', 'apps/api/duplicate.ts'].map(path => sourceFile(path, content));
  const repeated: Model = { ...model, analyze: async (_system, context) => {
    const input: unknown = JSON.parse(context);
    const parsed = z.object({ file: z.object({ path: z.string() }) }).parse(input);
    return { candidates: [{ path: parsed.file.path, line: 1, symbol: 'route', weakness: 'injection', title: 'Unbounded command', evidence: 'Input reaches exec', assumptions: [], severity: 'high', confidence: 0.9 }] };
  } };
  const result = await scan(request(), files, repeated, new AbortController().signal);
  assert.equal(result.candidates.length, 2);
  assert.equal(new Set(result.candidates.map(candidate => candidate.fingerprint)).size, 2);
  assert.ok(result.candidates.every(candidate => candidate.assumptions.some(value => value.includes('Ambiguous semantic anchor'))));
  const omitted = await scan(request(), files, { ...repeated, analyze: async (system, context, signal) => z.object({ file: z.object({ path: z.string() }) }).parse(JSON.parse(context)).file.path === 'apps/api/duplicate.ts' ? { candidates: [] } : repeated.analyze(system, context, signal) }, new AbortController().signal);
  assert.equal(omitted.candidates[0]?.fingerprint, result.candidates[0]?.fingerprint);
});

test('repeated credential exposure retains every location without exposing the literal', async () => {
  const literal = 'gh' + 'p_' + 'x'.repeat(24);
  const files = ['apps/api/first.ts', 'apps/api/second.ts'].map(path => sourceFile(path, `export const credential = "${literal}";`));
  const result = await scan(request(), files, { ...model, analyze: async () => ({ candidates: [] }) }, new AbortController().signal);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]?.fingerprint, result.candidates[1]?.fingerprint);
  assert.equal(new Set(result.candidates.map(candidate => candidate.path)).size, 2);
  assert.ok(!JSON.stringify(result).includes(literal));
});


test('authorization anchors use source syntax independently of changing model explanations', async () => {
  const body = 'export function visibleAccount(owner: string, id: string) {\n return records.find(record => record.id === id);\n}';
  const probe = (path: string, line: number, explanation: string): Model => ({ ...model, analyze: async () => ({ candidates: [{ path, line, symbol: 'visibleAccount', weakness: 'authorization', title: 'Missing owner filter', evidence: explanation, assumptions: [], severity: 'high', confidence: 0.9 }] }) });
  const first = await scan(request(), [sourceFile('apps/api/old.ts', body)], probe('apps/api/old.ts', 2, 'The supplied owner is not compared'), new AbortController().signal);
  const moved = await scan(request(), [sourceFile('apps/api/moved.ts', '\n' + body)], probe('apps/api/moved.ts', 3, 'The lookup ignores the authenticated principal'), new AbortController().signal);
  assert.equal(first.candidates.length, 1); assert.equal(moved.candidates.length, 1); assert.equal(first.candidates[0]?.fingerprint, moved.candidates[0]?.fingerprint);
  const ambiguous = await scan(request(), [sourceFile('apps/api/old.ts', body), sourceFile('apps/api/copy.ts', body)], probe('apps/api/old.ts', 2, 'Different prose'), new AbortController().signal);
  assert.ok(ambiguous.candidates[0]?.assumptions.some(value => value.includes('Ambiguous semantic anchor')));
});
