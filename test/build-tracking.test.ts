import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '@hivemagnus/embermend-integrations';
import { commit } from './fixtures.js';

const repository = { id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' };
const expected = { runId: 42, runAttempt: 2, workflowId: 7, workflowPath: '.github/workflows/build.yml', sourceCommit: commit, branch: 'main' };
const run = () => ({ id: 42, run_attempt: 2, workflow_id: 7, path: expected.workflowPath, head_sha: commit, head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture-owner/fixture-repository/actions/runs/42', updated_at: new Date().toISOString(), repository: { id: 123 }, head_repository: { id: 123 } });
test('workflow observation pins the exact attempt and makes only read requests', async () => {
  const calls: { path: string; method: string }[] = [];
  const request: typeof fetch = async (url, init) => { const path = new URL(String(url)).pathname; calls.push({ path, method: init?.method ?? 'GET' }); return Response.json(path.startsWith('/repositories/') ? repository : run()); };
  const client = new GitHubClient('fixture-read-token', [{ providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', allowedBranches: ['main'], workflowIds: ['7'] }], request);
  assert.equal((await client.buildRun('123', expected)).run_attempt, 2);
  assert.deepEqual(calls, [{ path: '/repositories/123', method: 'GET' }, { path: '/repos/fixture-owner/fixture-repository/actions/runs/42/attempts/2', method: 'GET' }]);
});
test('workflow observations reject forked sources, mismatched identities, URLs and malformed provider state', async () => {
  const changes: Record<string, unknown>[] = [
    { id: 43 }, { run_attempt: 3 }, { workflow_id: 8 }, { path: '.github/workflows/other.yml' }, { head_sha: 'b'.repeat(40) }, { head_branch: 'other' },
    { repository: { id: 456 } }, { head_repository: { id: 456 } }, { head_repository: null },
    { html_url: 'https://attacker.example.com/run/42' }, { html_url: 'https://github.com/fixture-owner/fixture-repository/actions/runs/43' },
    { status: 'in_progress' }, { conclusion: null }, { updated_at: new Date(Date.now() + 600000).toISOString() }, { status: 'unsupported' },
  ];
  for (const change of changes) {
    const methods: string[] = [];
    const request: typeof fetch = async (url, init) => { methods.push(init?.method ?? 'GET'); return Response.json(new URL(String(url)).pathname.startsWith('/repositories/') ? repository : { ...run(), ...change }); };
    const client = new GitHubClient('fixture-read-token', [{ providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', allowedBranches: ['main'], workflowIds: ['7'] }], request);
    await assert.rejects(client.buildRun('123', expected), Error, JSON.stringify(change)); assert.ok(methods.every(method => method === 'GET'));
  }
});
test('an ungranted workflow is refused before reading its run', async () => {
  let calls = 0; const request: typeof fetch = async () => { calls++; return Response.json(repository); };
  const client = new GitHubClient('fixture-read-token', [{ providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', allowedBranches: ['main'], workflowIds: [] }], request);
  await assert.rejects(client.buildRun('123', expected), /WORKFLOW_OUTSIDE_PROVIDER_GRANT/); assert.equal(calls, 1);
});
