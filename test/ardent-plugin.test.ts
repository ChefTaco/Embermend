import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArdentRuntime, ConfigSchema } from '@hivemagnus/ardent';
import plugin from '../packages/ardent-plugin/src/index.js';

test('the actual Ardent runtime preserves ingress prefixes and limits its OAuth request', async t => {
  const calls: { url: string; body: string | undefined; authorization: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input); calls.push({ url, body: typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined, authorization: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'fixture-short-lived-resource', expires_in: 300, token_type: 'Bearer' });
    return Response.json([]);
  });
  for (const prefix of ['', '/api/embermend', '/api/embermend/']) {
    const dir = await mkdtemp(join(tmpdir(), 'embermend-ardent-'));
    const config = ConfigSchema.parse({ schema_version: 1, profile: 'fixture', name: 'Fixture', timezone: 'UTC', execution: { backend: 'llamacpp', max_model_steps: 2, max_tool_calls: 2, max_parallel_tools: 1, deadline_seconds: 30, max_delegation_depth: 0 }, providers: { llamacpp: { base_url: 'https://model.example.com/v1', model: 'fixture-model', api_key_env: 'FIXTURE_MODEL_KEY', request_timeout_seconds: 30 }, codex: { command: 'codex', model: 'fixture-model', approval_policy: 'never', sandbox: 'read-only' } } });
    const runtime = new ArdentRuntime(dir, config, {});
    try {
      await runtime.usePlugins([plugin], { EMBERMEND_URL: 'https://suite.example.com' + prefix, EMBERMEND_OAUTH_TOKEN_URL: 'https://identity.example.com/oauth/token', EMBERMEND_OAUTH_CLIENT_ID: 'fixture-coordinator', EMBERMEND_OAUTH_CLIENT_SECRET: 'fixture-client-credential', EMBERMEND_OAUTH_SCOPE: 'embermend:read embermend:evidence' });
      const result = await runtime.tools.call('embermend_findings', {}, 'direct', AbortSignal.timeout(5000));
      assert.deepEqual(result, { ok: true, value: { findings: [] } });
      assert.equal(calls.at(-1)?.url, 'https://suite.example.com' + prefix.replace(/\/+$/, '') + '/api/v1/findings');
      assert.equal(calls.at(-1)?.authorization, 'Bearer fixture-short-lived-resource');
      const tokenCall = calls.at(-2); assert.ok(tokenCall?.body); assert.equal(new URLSearchParams(tokenCall.body).get('scope'), 'embermend:read embermend:evidence');
      assert.deepEqual(await runtime.tools.call('embermend_inventory', {}, 'direct', AbortSignal.timeout(5000)), { ok: true, value: { entities: [] } });
      assert.deepEqual(await runtime.tools.call('embermend_policies', {}, 'direct', AbortSignal.timeout(5000)), { ok: true, value: { policies: [] } });
      assert.ok(runtime.tools.list('direct').every(tool => !/approve|policy_create|recover|exception_accept/.test(tool.name)));
    } finally { runtime.close(); await rm(dir, { recursive: true, force: true }); }
  }
});
