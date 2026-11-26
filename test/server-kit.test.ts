import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { OathweaveError, isOathweaveError } from '@hivemagnus/hive-common/oathweave';
import { Embermend } from '@hivemagnus/embermend-core';
import { database } from '@hivemagnus/embermend-store';
import { MagnusClient, identityProviderUnavailable, oathweaveAuthenticator } from '@hivemagnus/embermend-integrations';
import { createApi } from '../services/runtime/src/api.js';
import { operator, scope } from './fixtures.js';

const issuer = 'https://identity.example.com';
const config = { issuer, jwksUrl: `${issuer}/jwks`, userinfoUrl: `${issuer}/userinfo`, grants: [{ subject: 'fixture-user', kind: 'operator' as const, permissions: ['read' as const], scope }] };
async function userToken() {
  const pair = await generateKeyPair('RS256'); const publicKey = await exportJWK(pair.publicKey); publicKey.kid = 'fixture-key';
  const token = await new SignJWT({ permissions: ['embermend:read'], actorType: 'USER', sessionId: 'fixture-session', clientId: 'hivexui-embermend', roles: [] }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(issuer).setAudience('embermend').setSubject('fixture-user').setJti('fixture-token-id').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  return { token, keys: createLocalJWKSet({ keys: [publicKey] }) };
}

test('an identity-provider outage is told apart from a revoked or refused identity', async () => {
  const { token, keys } = await userToken();
  const answer = (status: number) => oathweaveAuthenticator(config, { keys, request: async () => Response.json(status === 200 ? { sub: 'fixture-user' } : { error: 'fixture' }, { status }) });
  assert.equal((await answer(200)(token)).id, 'fixture-user');
  for (const status of [500, 502, 503]) await assert.rejects(answer(status)(token), (error: unknown) => identityProviderUnavailable(error), String(status));
  for (const status of [401, 403]) await assert.rejects(answer(status)(token), (error: unknown) => isOathweaveError(error) && error.reason === 'session_inactive' && !identityProviderUnavailable(error), String(status));
  await assert.rejects(oathweaveAuthenticator(config, { keys, request: async () => { throw new TypeError('fixture network failure'); } })(token), (error: unknown) => identityProviderUnavailable(error));
  // Keys that cannot be fetched are an outage; a bad signature or unknown key is a refusal.
  await assert.rejects(oathweaveAuthenticator(config, { keys: async () => { throw new TypeError('fixture JWKS outage'); } })(token), (error: unknown) => isOathweaveError(error) && error.reason === 'jwks_unavailable');
  const other = await userToken();
  await assert.rejects(oathweaveAuthenticator(config, { keys: other.keys })(token), (error: unknown) => isOathweaveError(error) && !identityProviderUnavailable(error));
  // Grants are read on every request when given as a function.
  let grants = config.grants; const live = oathweaveAuthenticator({ ...config, grants: () => grants }, { keys, request: async () => Response.json({ sub: 'fixture-user' }) });
  assert.equal((await live(token)).id, 'fixture-user'); grants = []; await assert.rejects(live(token), /EXPLICIT_UNIQUE_PRODUCT_GRANT_REQUIRED/);
});

test('the API answers 503 with Retry-After for an identity outage, sends suite headers and serves readiness', async t => {
  const db = database('postgresql://fixture:fixture@127.0.0.1:1/embermend_test_server_kit');
  t.after(async () => db.$disconnect());
  const service = new Embermend(db, new MagnusClient('https://magnus.example.com', 'fixture-magnus-token-not-real-000000'));
  const headers = { authorization: 'Bearer fixture-product-token' };
  const outage = await createApi(service, async () => { throw new OathweaveError('identity_unavailable'); }).request('/api/v1/access', { headers });
  assert.equal(outage.status, 503); assert.equal(outage.headers.get('retry-after'), '1'); assert.deepEqual(await outage.json(), { error: 'IDENTITY_PROVIDER_UNAVAILABLE' });
  const refused = await createApi(service, async () => { throw new OathweaveError('session_inactive'); }).request('/api/v1/access', { headers });
  assert.equal(refused.status, 401); assert.deepEqual(await refused.json(), { error: 'IDENTITY_OR_PRODUCT_ACCESS_DENIED' });
  const app = createApi(service, async () => operator);
  const access = await app.request('/api/v1/access', { headers });
  assert.equal(access.status, 200); assert.equal(access.headers.get('x-content-type-options'), 'nosniff'); assert.equal(access.headers.get('cache-control'), 'no-store'); assert.ok(access.headers.get('x-request-id'));
  const live = await app.request('/health/live');
  assert.equal(live.status, 200); assert.deepEqual(await live.json(), { status: 'alive', version: (await import('@hivemagnus/embermend-contracts')).VERSION }); assert.equal(live.headers.get('cache-control'), 'no-store');
  // No database: readiness fails without authentication or detail.
  const ready = await app.request('/health/ready');
  assert.equal(ready.status, 503);
  const body = await ready.json() as unknown;
  assert.equal(typeof body === 'object' && body !== null && 'status' in body ? body.status : undefined, 'not_ready');
  assert.ok(!JSON.stringify(body).includes('127.0.0.1'));
});

test('Magnus paths are joined under a MAGNUS_URL base path', async () => {
  const seen: string[] = [];
  const request: typeof fetch = async input => { seen.push(String(input)); return Response.json({ error: 'fixture' }, { status: 404 }); };
  for (const base of ['https://magnus.example.com', 'https://magnus.example.com/', 'https://gateway.example.com/magnus', 'https://gateway.example.com/magnus/']) await assert.rejects(new MagnusClient(base, 'fixture-magnus-token-not-real-000000', request).receipt('fixture operation/1'), /MAGNUS_HTTP_404/);
  assert.deepEqual(seen, [
    'https://magnus.example.com/api/v1/embermend/operations/fixture%20operation%2F1',
    'https://magnus.example.com/api/v1/embermend/operations/fixture%20operation%2F1',
    'https://gateway.example.com/magnus/api/v1/embermend/operations/fixture%20operation%2F1',
    'https://gateway.example.com/magnus/api/v1/embermend/operations/fixture%20operation%2F1',
  ]);
});
