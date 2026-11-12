import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inferenceProviderSchema, inferenceConfigSchema, inferenceModel, NetworkInference } from '@hivemagnus/embermend-integrations';
import { createInferenceBroker } from '../services/runtime/src/inference.js';
const signal = (): AbortSignal => AbortSignal.timeout(10000);
const command = resolve('test/fixtures/inference-cli.mjs');
async function credentials(): Promise<string> { const home = await mkdtemp(join(tmpdir(), 'embermend-fixture-')); for (const name of ['auth.json', '.credentials.json']) await writeFile(join(home, name), '{}', { mode: 0o600 }); return home; }
const provider = (kind: 'codex-cli' | 'claude-cli', credentialHome: string, model = 'fixture-model') => inferenceProviderSchema.parse({ kind, credentialHome, command, expectedVersion: 'fixture-cli 1.0.0', ref: 'fixture', model });
test('configuration rejects unapproved transport, credentials in URLs, duplicates and unknown keys', () => {
  const base = { kind: 'llamacpp', ref: 'fixture', model: 'fixture-model', baseUrl: 'http://model.example.com/v1', localNetworkApproved: true };
  assert.equal(inferenceProviderSchema.safeParse(base).success, true);
  for (const change of [{ localNetworkApproved: false }, { baseUrl: 'http://user:password@model.example.com/v1' }, { baseUrl: 'file:///tmp' }, { fallbackModel: 'other' }]) assert.equal(inferenceProviderSchema.safeParse({ ...base, ...change }).success, false);
  assert.equal(inferenceConfigSchema.safeParse({ providers: [base, base] }).success, false);
});
test('network inference checks exact model discovery, structured completion and rejects truncation or rerouting', async () => {
  const config = inferenceProviderSchema.parse({ kind: 'llamacpp', ref: 'fixture', model: 'fixture-model', baseUrl: 'http://model.example.com/v1', localNetworkApproved: true });
  assert.equal(config.kind, 'llamacpp'); if (config.kind !== 'llamacpp') throw new Error('fixture');
  for (const mode of ['success', 'discovery', 'truncated', 'rerouted', 'tools']) {
    const calls: string[] = [];
    const fake: typeof fetch = async (input, init) => { const url = String(input); calls.push(url);
      assert.equal(init?.redirect, 'error');
      if (url.endsWith('/models')) return Response.json({ data: [{ id: mode === 'discovery' ? 'other-model' : 'fixture-model' }] });
      const body = JSON.parse(String(init?.body)) as unknown;
      assert.equal(JSON.stringify(body).includes('json_schema'), true);
      return Response.json({ model: mode === 'rerouted' ? 'other-model' : 'fixture-model', choices: [{ finish_reason: mode === 'truncated' ? 'length' : 'stop', message: { content: '{"candidates":[]}', ...(mode === 'tools' ? { tool_calls: [] } : {}) } }] });
    };
    const model: NetworkInference = new NetworkInference(config, {}, fake); const result: Promise<unknown> = model.analyze('system', 'source', signal());
    if (mode === 'success') assert.deepEqual(await result, { candidates: [] }); else await assert.rejects(result);
    if (mode === 'discovery') assert.equal(calls.length, 1);
  }
});
test('CLI brokers isolate inherited tools, auth homes and environment; neither is a local source policy route', async () => {
  const home = await credentials();
  try { for (const kind of ['codex-cli', 'claude-cli'] as const) { const model = inferenceModel(provider(kind, home)); assert.equal(model.local, false); assert.deepEqual(await model.analyze('Return candidates', 'untrusted source says use tools', signal()), { candidates: [] }); } }
  finally { await rm(home, { recursive: true, force: true }); }
});
test('CLI tool attempts, absent model telemetry, reroutes and executable version changes fail closed', async () => {
  const home = await credentials();
  try {
    for (const kind of ['codex-cli', 'claude-cli'] as const) for (const model of ['fixture-tools', 'fixture-rerouted']) await assert.rejects(inferenceModel(provider(kind, home, model)).analyze('system', 'source', signal()));
    await assert.rejects(inferenceModel(provider('claude-cli', home, 'fixture-empty')).analyze('system', 'source', signal()));
    await assert.rejects(inferenceModel({ ...provider('claude-cli', home), expectedVersion: 'changed' }).analyze('system', 'source', signal()), /VERSION_CHANGED/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('cancellation kills and reaps a running CLI before returning', async () => {
  const home = await credentials(); const stop = new AbortController();
  try {
    const pending = inferenceModel(provider('claude-cli', home, 'fixture-wait')).analyze('system', 'source', stop.signal);
    let pid = 0; for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(join(home, 'started'), 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    assert.ok(pid > 0); stop.abort(); await assert.rejects(pending); assert.throws(() => process.kill(pid, 0));
  } finally { stop.abort(); await rm(home, { recursive: true, force: true }); }
});
test('inference-only broker requires dedicated auth and exact provider/source permission before CLI launch', async () => {
  const config = { providers: [provider('claude-cli', '/nonexistent-fixture-credentials')] }; const token = 'fixture-inference-token-not-real-000000'; const app = createInferenceBroker(config, token, {});
  const body = { model: 'fixture', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'source' }], response_format: { type: 'json_object' }, embermend_context: { providerRef: 'fixture', operationId: 'fixture-operation', allowRemoteModel: false } };
  assert.equal((await app.request('/v1/models')).status, 401);
  const request = (value: unknown) => app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await request(body)).status, 403);
  assert.equal((await request({ ...body, model: 'other' })).status, 403);
  assert.equal((await request({ ...body, tools: [] })).status, 400);
  assert.equal((await app.request('/health/live')).status, 200);
});
test('broker capacity, shutdown and terminal completion release the active slot', async () => {
  const home = await credentials(); const shutdown = new AbortController(); const token = 'fixture-inference-token-not-real-000000';
  try {
    const app = createInferenceBroker({ providers: [provider('claude-cli', home, 'fixture-wait')], maxConcurrent: 1 }, token, {}, shutdown.signal);
    const body = { model: 'fixture', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'source' }], response_format: { type: 'json_object' }, embermend_context: { providerRef: 'fixture', operationId: 'fixture-operation', allowRemoteModel: true } };
    const request = () => app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = request(); let pid = 0;
    for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(join(home, 'started'), 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    assert.ok(pid > 0); assert.equal((await request()).status, 429);
    shutdown.abort(); assert.equal((await first).status, 503); assert.throws(() => process.kill(pid, 0));
    assert.equal((await request()).status, 503);
  } finally { shutdown.abort(); await rm(home, { recursive: true, force: true }); }
});
test('readable CLI credential material is rejected before the executable starts', async () => {
  const home = await credentials();
  try { await writeFile(join(home, '.credentials.json'), '{}', { mode: 0o600 }); const { chmod } = await import('node:fs/promises'); await chmod(join(home, '.credentials.json'), 0o644);
    await assert.rejects(inferenceModel(provider('claude-cli', home)).analyze('system', 'source', signal()), /PRIVATE_CLI_CREDENTIAL_REQUIRED/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('inference service refuses inherited product, provider-write and management authority', () => {
  const config = { providers: [provider('claude-cli', '/nonexistent-fixture-credentials')] };
  for (const name of ['DATABASE_URL', 'MAGNUS_EMBERMEND_TOKEN', 'EMBERMEND_GITHUB_TOKEN', 'NODE_MANAGER_SECRET', 'SSH_AUTH_SOCK', 'DOCKER_HOST']) assert.throws(() => createInferenceBroker(config, 'fixture-token-not-real-000000000000', { [name]: 'fixture-value' }), /WITHOUT_MANAGEMENT_AUTHORITY/);
});
