import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '@hivemagnus/embermend-integrations';
import { commit } from './fixtures.js';
const grants = [{ providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', allowedBranches: ['main'], workflowIds: ['release.yml'] }];
test('repository transfers invalidate access before provider writes', async () => {
  const methods: string[] = []; const request: typeof fetch = async (_url, init) => { methods.push(init?.method ?? 'GET'); return Response.json({ id: 123, full_name: 'another-owner/fixture-repository', owner: { login: 'another-owner' }, name: 'fixture-repository', default_branch: 'main' }); };
  const client = new GitHubClient('fixture-provider-token', grants, request); await assert.rejects(client.createBranch('123', 'embermend/fixture', commit), /TRANSFER_OR_RENAME/); assert.deepEqual(methods, ['GET']);
});
test('branch writes are limited to dedicated remediation branches', async () => {
  const methods: string[] = []; const request: typeof fetch = async (_url, init) => { methods.push(init?.method ?? 'GET'); return Response.json({ id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' }); };
  const client = new GitHubClient('fixture-provider-token', grants, request); await assert.rejects(client.createBranch('123', 'main', commit), /REMEDIATION_BRANCH/); assert.deepEqual(methods, ['GET']);
});
test('merge refuses changed heads and never alters protection settings', async () => {
  const urls: string[] = []; const request: typeof fetch = async (url) => { const path = String(url); urls.push(path); return Response.json(path.includes('/repositories/') ? { id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' } : { number: 1, state: 'open', merged: false, merge_commit_sha: null, head: { sha: 'b'.repeat(40), ref: 'embermend/fixture' }, base: { ref: 'main', sha: commit } }); };
  const client = new GitHubClient('fixture-provider-token', grants, request); await assert.rejects(client.merge('123', 1, commit), /HEAD_OR_BASE_CHANGED/); assert.ok(urls.every(url => !url.includes('/merge') && !url.includes('/protection')));
});

test('merge fails closed for incomplete checks, blocked rules, reviews and administrative credentials', async () => {
  for (const refusal of ['incomplete', 'duplicate-check', 'blocked', 'review-required', 'admin', 'unknown', 'changed-base', 'graphql-errors']) {
    const writes: string[] = [];
    const request: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method !== 'GET' && path !== '/graphql') writes.push(path);
      if (path.startsWith('/repositories/')) return Response.json({ id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' });
      if (path.endsWith('/check-runs')) return Response.json({ total_count: refusal === 'incomplete' || refusal === 'duplicate-check' ? 2 : 1, check_runs: Array.from({ length: refusal === 'duplicate-check' ? 2 : 1 }, () => ({ id: 1, name: 'Verify', head_sha: commit, status: 'completed', conclusion: 'success' })) });
      if (path === '/graphql') return Response.json({ data: { repository: { databaseId: 123, nameWithOwner: 'fixture-owner/fixture-repository', viewerPermission: refusal === 'admin' ? 'ADMIN' : 'WRITE', pullRequest: { headRefOid: commit, baseRefName: 'main', baseRefOid: refusal === 'changed-base' ? 'b'.repeat(40) : commit, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: refusal === 'blocked' ? 'BLOCKED' : refusal === 'unknown' ? 'UNKNOWN' : 'CLEAN', reviewDecision: refusal === 'review-required' ? 'REVIEW_REQUIRED' : 'APPROVED' } } }, ...(refusal === 'graphql-errors' ? { errors: [{ message: 'Fixture authorization failure' }] } : {}) });
      return Response.json({ number: 1, state: 'open', merged: false, merge_commit_sha: null, head: { sha: commit, ref: 'embermend/fixture' }, base: { ref: 'main', sha: commit } });
    };
    await assert.rejects(new GitHubClient('fixture-provider-token', grants, request).merge('123', 1, commit)); assert.deepEqual(writes, [], refusal);
  }
});

test('a ready non-administrator merge pins the reviewed head in its only write', async () => {
  const writes: unknown[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith('/repositories/')) return Response.json({ id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' });
    if (path.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{ id: 1, name: 'Verify', head_sha: commit, status: 'completed', conclusion: 'success' }] });
    if (path === '/graphql') return Response.json({ data: { repository: { databaseId: 123, nameWithOwner: 'fixture-owner/fixture-repository', viewerPermission: 'WRITE', pullRequest: { headRefOid: commit, baseRefName: 'main', baseRefOid: commit, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' } } } });
    if (path.endsWith('/merge')) { writes.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null); return Response.json({ merged: true, sha: 'b'.repeat(40) }); }
    return Response.json({ number: 1, state: 'open', merged: false, merge_commit_sha: null, head: { sha: commit, ref: 'embermend/fixture' }, base: { ref: 'main', sha: commit } });
  };
  assert.equal(await new GitHubClient('fixture-provider-token', grants, request).merge('123', 1, commit), 'b'.repeat(40)); assert.deepEqual(writes, [{ sha: commit, merge_method: 'squash' }]);
});
