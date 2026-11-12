import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { oathweaveAuthenticator, ResourceTokenProvider } from '@hivemagnus/embermend-integrations';
import { scope } from './fixtures.js';

test('Oathweave users and machine identities have separate non-escalating authority', async () => {
  const pair = await generateKeyPair('RS256'); const publicKey = await exportJWK(pair.publicKey); publicKey.kid = 'fixture-key'; const keys = createLocalJWKSet({ keys: [publicKey] });
  let live = true;
  const request: typeof fetch = async () => Response.json(live ? { sub: 'fixture-user' } : { error: 'revoked' }, { status: live ? 200 : 401 });
  const auth = oathweaveAuthenticator({ issuer: 'https://identity.example.com', jwksUrl: 'https://identity.example.com/jwks', userinfoUrl: 'https://identity.example.com/userinfo', grants: [{ subject: 'fixture-user', kind: 'operator', permissions: ['read', 'approve'], scope }, { subject: 'fixture-coordinator', kind: 'coordinator', permissions: ['read', 'execute'], scope }] }, { keys, request });
  const sign = async (subject: string, extra: Record<string, unknown>, lifetime = 300) => new SignJWT({ permissions: ['embermend:read', 'embermend:approve', 'embermend:execute'], ...extra }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer('https://identity.example.com').setAudience('embermend').setSubject(subject).setJti('fixture-token-id').setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + lifetime).sign(pair.privateKey);
  const user = await sign('fixture-user', { actorType: 'USER', sessionId: 'fixture-session', clientId: 'hivexui-embermend', roles: [] });
  assert.equal((await auth(user)).permissions.has('approve'), true);
  live = false; await assert.rejects(auth(user), /REVOKED/);
  const machine = await sign('fixture-coordinator', { actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'fixture-coordinator' });
  const actor = await auth(machine); assert.equal(actor.kind, 'coordinator'); assert.equal(actor.permissions.has('approve'), false);
  await assert.rejects(auth(await sign('fixture-coordinator', { actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'fixture-coordinator', sessionId: 'forged-session' })));
  await assert.rejects(auth(await sign('fixture-coordinator', { actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'fixture-coordinator' }, 3600)), /LIFETIME/);
});
test('service token refresh is shared and cannot silently use an unscoped fallback', async () => {
  let calls = 0; const request: typeof fetch = async (_url, init) => { calls++; assert.ok(String(init?.body).includes('client_credentials')); return Response.json({ access_token: 'fixture-resource-token', expires_in: 300, token_type: 'Bearer' }); };
  const provider = new ResourceTokenProvider({ tokenUrl: 'https://identity.example.com/token', clientId: 'fixture-client', clientSecret: 'fixture-client-secret', scope: 'embermend:read' }, request);
  const tokens = await Promise.all([provider.token(), provider.token()]); assert.equal(calls, 1); assert.deepEqual(tokens, ['fixture-resource-token', 'fixture-resource-token']);
});
test('an audit collector service account is granted embermend:audit:read only when its token carries it', async () => {
  const pair = await generateKeyPair('RS256'); const publicKey = await exportJWK(pair.publicKey); publicKey.kid = 'fixture-key'; const keys = createLocalJWKSet({ keys: [publicKey] });
  const auth = oathweaveAuthenticator({ issuer: 'https://identity.example.com', jwksUrl: 'https://identity.example.com/jwks', userinfoUrl: 'https://identity.example.com/userinfo', grants: [{ subject: 'fixture-collector', kind: 'integration', permissions: ['audit:read'], scope }] }, { keys });
  const sign = async (permissions: string[]) => new SignJWT({ permissions, actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'fixture-collector' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer('https://identity.example.com').setAudience('embermend').setSubject('fixture-collector').setJti('fixture-audit-jti').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const actor = await auth(await sign(['embermend:audit:read']));
  assert.equal(actor.kind, 'integration'); assert.deepEqual([...actor.permissions], ['audit:read']);
  assert.deepEqual([...(await auth(await sign(['embermend:read']))).permissions], []);
});
