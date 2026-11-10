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

test('merge fails closed for incomplete checks, blocked rules and missing reviews regardless of role', async () => {
  for (const refusal of ['incomplete', 'duplicate-check', 'blocked', 'review-required', 'admin-blocked', 'unknown', 'changed-base', 'graphql-errors']) {
    const writes: string[] = [];
    const request: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method !== 'GET' && path !== '/graphql') writes.push(path);
      if (path.startsWith('/repositories/')) return Response.json({ id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' });
      if (path.endsWith('/check-runs')) return Response.json({ total_count: refusal === 'incomplete' || refusal === 'duplicate-check' ? 2 : 1, check_runs: Array.from({ length: refusal === 'duplicate-check' ? 2 : 1 }, () => ({ id: 1, name: 'Verify', head_sha: commit, status: 'completed', conclusion: 'success' })) });
      if (path === '/graphql') return Response.json({ data: { repository: { databaseId: 123, nameWithOwner: 'fixture-owner/fixture-repository', viewerPermission: refusal === 'admin-blocked' ? 'ADMIN' : 'WRITE', pullRequest: { headRefOid: commit, baseRefName: 'main', baseRefOid: refusal === 'changed-base' ? 'b'.repeat(40) : commit, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: ['blocked', 'admin-blocked'].includes(refusal) ? 'BLOCKED' : refusal === 'unknown' ? 'UNKNOWN' : 'CLEAN', reviewDecision: refusal === 'review-required' ? 'REVIEW_REQUIRED' : 'APPROVED' } } }, ...(refusal === 'graphql-errors' ? { errors: [{ message: 'Fixture authorization failure' }] } : {}) });
      return Response.json({ number: 1, state: 'open', merged: false, merge_commit_sha: null, head: { sha: commit, ref: 'embermend/fixture' }, base: { ref: 'main', sha: commit } });
    };
    await assert.rejects(new GitHubClient('fixture-provider-token', grants, request).merge('123', 1, commit)); assert.deepEqual(writes, [], refusal);
  }
});

const mergeUuid = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
const pendingMerge = (extra: Record<string, unknown> = {}) => ({ status: 'pending', details: { uuid: mergeUuid, expected_head_sha: commit, merge_method: 'squash', merge_action: 'default', bypass_rules: false, ...extra } });
const repoReply = { id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' };
const pullReply = { number: 1, state: 'open', merged: false, merge_commit_sha: null, head: { sha: commit, ref: 'embermend/fixture' }, base: { ref: 'main', sha: commit } };
test('ready administrator and app identities use exact-head merging with server rule bypass disabled', async () => {
  for (const role of ['WRITE', 'MAINTAIN', 'ADMIN', null]) {
    const writes: { path: string; body: unknown; version: string | null }[] = [];
    const request: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith('/repositories/')) return Response.json(repoReply);
      if (path.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{ id: 1, name: 'Verify', head_sha: commit, status: 'completed', conclusion: 'success' }] });
      if (path === '/graphql') return Response.json({ data: { repository: { databaseId: 123, nameWithOwner: 'fixture-owner/fixture-repository', viewerPermission: role, pullRequest: { headRefOid: commit, baseRefName: 'main', baseRefOid: commit, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' } } } });
      if (init?.method === 'PUT') { writes.push({ path, body: JSON.parse(String(init.body)) as unknown, version: new Headers(init.headers).get('x-github-api-version') }); return Response.json(pendingMerge(), { status: 202 }); }
      return Response.json(pullReply);
    };
    const operation = await new GitHubClient('fixture-provider-token', grants, request).merge('123', 1, commit);
    assert.equal(operation.state, 'pending'); assert.equal(operation.requestId, mergeUuid);
    assert.deepEqual(writes, [{ path: '/repos/fixture-owner/fixture-repository/pulls/1/merge-async', body: { sha: commit, merge_method: 'squash', merge_action: 'default', bypass_rules: false }, version: '2026-03-10' }]);
  }
});
test('merge queue acceptance remains pending until a matching merge commit is observed without another mutation', async () => {
  let phase = 'pending'; const methods: string[] = [];
  const request: typeof fetch = async (url, init) => {
    methods.push(init?.method ?? 'GET'); const path = new URL(String(url)).pathname;
    if (path.startsWith('/repositories/')) return Response.json(repoReply);
    if (path.includes('/merge-async/')) return Response.json(phase === 'pending' ? pendingMerge() : { status: 'enqueued', details: {} });
    return Response.json({ ...pullReply, ...(phase === 'merged' ? { merged: true, state: 'closed', merge_commit_sha: 'b'.repeat(40) } : {}) });
  };
  const client = new GitHubClient('fixture-provider-token', grants, request);
  const original = { providerId: '123', pullNumber: 1, headCommit: commit, bypassRules: false, state: 'pending', requestId: mergeUuid, commit: null };
  assert.equal((await client.observeMerge('123', original)).state, 'pending'); phase = 'enqueued'; assert.equal((await client.observeMerge('123', original)).state, 'enqueued'); phase = 'merged'; const merged = await client.observeMerge('123', original); assert.equal(merged.state, 'merged'); assert.equal(merged.commit, 'b'.repeat(40)); assert.ok(methods.every(method => method === 'GET'));
});
test('asynchronous merge observation refuses mismatched identities, bypass and unconfirmed commits', async () => {
  for (const mode of ['uuid', 'head', 'bypass', 'commit']) {
    const request: typeof fetch = async url => { const path = new URL(String(url)).pathname; if (path.startsWith('/repositories/')) return Response.json(repoReply);
      if (path.includes('/merge-async/')) return Response.json(mode === 'commit' ? { status: 'merged', details: { sha: 'b'.repeat(40) } } : pendingMerge(mode === 'uuid' ? { uuid: '730b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42' } : mode === 'head' ? { expected_head_sha: 'b'.repeat(40) } : { bypass_rules: true }));
      return Response.json(pullReply);
    };
    await assert.rejects(new GitHubClient('fixture-provider-token', grants, request).observeMerge('123', { providerId: '123', pullNumber: 1, headCommit: commit, bypassRules: false, state: 'pending', requestId: mergeUuid, commit: null }));
  }
});
test('provider permission refusal and conflicting pending options never select a merge fallback', async () => {
  for (const mode of ['forbidden', 'unsupported', 'bypass', 'unspecified-bypass', 'head', 'failed']) {
    const writes: string[] = [];
    const request: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith('/repositories/')) return Response.json(repoReply);
      if (path.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{ id: 1, name: 'Verify', head_sha: commit, status: 'completed', conclusion: 'success' }] });
      if (path === '/graphql') return Response.json({ data: { repository: { databaseId: 123, nameWithOwner: 'fixture-owner/fixture-repository', pullRequest: { headRefOid: commit, baseRefName: 'main', baseRefOid: commit, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null } } } });
      if (init?.method === 'PUT') {
        writes.push(path);
        if (mode === 'forbidden' || mode === 'unsupported') return Response.json({ message: 'Fixture refusal' }, { status: mode === 'forbidden' ? 403 : 404 });
        if (mode === 'failed') return Response.json({ status: 'failed', details: { message: 'Fixture PR closed' } }, { status: 400 });
        const details: Record<string, unknown> = pendingMerge(mode === 'bypass' ? { bypass_rules: true } : mode === 'head' ? { expected_head_sha: 'b'.repeat(40) } : {}).details;
        if (mode === 'unspecified-bypass') delete details['bypass_rules'];
        return Response.json({ status: 'pending', details }, { status: 409 });
      }
      return Response.json(pullReply);
    };
    const result = new GitHubClient('fixture-provider-token', grants, request).merge('123', 1, commit);
    if (mode === 'failed') assert.equal((await result).state, 'failed'); else await assert.rejects(result);
    assert.deepEqual(writes, ['/repos/fixture-owner/fixture-repository/pulls/1/merge-async']);
  }
});
test('expired merge request results use original PR evidence and never authorize replay', async () => {
  let merged = false; const methods: string[] = [];
  const request: typeof fetch = async (url, init) => {
    methods.push(init?.method ?? 'GET'); const path = new URL(String(url)).pathname;
    if (path.startsWith('/repositories/')) return Response.json(repoReply);
    if (path.includes('/merge-async/')) return Response.json({ message: 'Fixture expired request' }, { status: 404 });
    return Response.json({ ...pullReply, ...(merged ? { merged: true, state: 'closed', merge_commit_sha: 'b'.repeat(40) } : {}) });
  };
  const client = new GitHubClient('fixture-provider-token', grants, request);
  const original = { providerId: '123', pullNumber: 1, headCommit: commit, bypassRules: false, state: 'pending', requestId: mergeUuid, commit: null };
  const pending = await client.observeMerge('123', original); assert.equal(pending.state, 'pending'); assert.equal(pending.requestId, mergeUuid);
  merged = true; assert.equal((await client.observeMerge('123', original)).commit, 'b'.repeat(40)); assert.ok(methods.every(method => method === 'GET'));
});
