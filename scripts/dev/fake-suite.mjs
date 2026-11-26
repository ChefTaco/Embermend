// Local development stand-ins for Magnus and Oathweave. Never use outside compose.dev.yaml:
// the identity side mints tokens for any subject on request.
//
//   node fake-suite.mjs serve            HTTPS: Magnus on :8443, Oathweave on :9443
//   node fake-suite.mjs token <subject>  print a 10-minute operator token for <subject>
//   node fake-suite.mjs service <client> print a 10-minute service-account token
import { createHash, createSign, generateKeyPairSync, randomUUID, createPrivateKey, createPublicKey } from 'node:crypto';
import { createServer } from 'node:https';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const certs = process.env.FAKE_SUITE_CERTS ?? '/certs';
const host = process.env.FAKE_SUITE_HOST ?? 'fake-suite';
const issuer = `https://${host}:9443`;
const signingKey = `${certs}/identity-signing.pem`;
const installationId = process.env.FAKE_SUITE_INSTALLATION ?? 'dev-installation';
const scope = { installationId, applicationIds: ['dev-app'], targetIds: ['dev-node'] };
const permissions = ['read', 'evidence', 'evidence-restricted', 'assess', 'prepare', 'propose', 'publish-explanation', 'execute', 'approve', 'policy', 'repository-write', 'merge', 'artifact-publish', 'deploy', 'exception', 'recover', 'ingest', 'audit:read'];

function key() {
  if (!existsSync(signingKey)) writeFileSync(signingKey, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return createPrivateKey(readFileSync(signingKey));
}
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function sign(claims) {
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'dev-key' }); const payload = b64(claims);
  return `${header}.${payload}.${createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key()).toString('base64url')}`;
}
function token(subject, kind) {
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: issuer, aud: 'embermend', sub: subject, jti: randomUUID(), iat: now, exp: now + 600, permissions: permissions.map(permission => `embermend:${permission}`) };
  return sign(kind === 'service' ? { ...base, actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: subject } : { ...base, actorType: 'USER', sessionId: randomUUID(), clientId: 'dev-client', roles: [] });
}

// Embermend's canonical request digest (packages/store: sorted keys, sha256).
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

function target() {
  const now = new Date().toISOString();
  return { id: 'dev-node', kind: 'target', label: 'Development host', scope, provenance: { source: 'magnus', assurance: 'established', evidenceIds: [], observedAt: now }, magnusInstallationId: 'dev-magnus', magnusTargetId: 'dev-node', agentId: 'dev-agent', environment: 'lab', targetKind: 'host', enrollment: 'enrolled', platform: 'ubuntu-24.04', capabilities: ['embermend:inventory.v1', 'embermend:file-mode.v1'], lastSeenAt: now, parentHostId: null, workloadId: null, instanceId: null, executionNamespace: 'host', lifecycle: 'active' };
}

async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; }
const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
const tls = { key: readFileSync(`${certs}/fake-suite.key`), cert: readFileSync(`${certs}/fake-suite.crt`) };

function serve() {
  const receipts = new Map();
  const magnusToken = process.env.MAGNUS_EMBERMEND_TOKEN;
  createServer(tls, async (request, response) => {
    if (request.headers.authorization !== `Bearer ${magnusToken}`) return send(response, 401, { error: 'unauthorized' });
    const url = new URL(request.url ?? '/', 'https://localhost');
    if (request.method === 'GET' && url.pathname === '/api/v1/embermend/capabilities') return send(response, 200, { protocol: 1, installationId: 'dev-magnus', serviceVersion: 'dev', actions: ['inventory.v1', 'file-mode.v1'], targets: [target()], observedAt: new Date().toISOString() });
    if (request.method === 'POST' && url.pathname === '/api/v1/embermend/operations') {
      const operation = await body(request);
      // Every operation "completes" at once with exit code 0: enough to walk the flows locally.
      const receipt = { operationId: operation.operationId, requestDigest: digest(operation), targetId: operation.action.targetId, state: 'completed', evidenceIds: [], result: { exitCode: 0 }, ownershipReleased: true, observedAt: new Date().toISOString() };
      receipts.set(operation.operationId, receipt); return send(response, 200, receipt);
    }
    const match = /^\/api\/v1\/embermend\/operations\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && match) { const receipt = receipts.get(decodeURIComponent(match[1])); return receipt ? send(response, 200, receipt) : send(response, 404, { error: 'not_found' }); }
    send(response, 404, { error: 'not_found' });
  }).listen(8443, () => console.log('fake Magnus on :8443'));
  const jwk = { ...createPublicKey(key()).export({ format: 'jwk' }), kid: 'dev-key', alg: 'RS256', use: 'sig' };
  createServer(tls, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://localhost');
    if (url.pathname === '/jwks') return send(response, 200, { keys: [jwk] });
    if (url.pathname === '/userinfo') {
      const value = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]?.split('.')[1];
      if (!value) return send(response, 401, { error: 'invalid_token' });
      return send(response, 200, { sub: JSON.parse(Buffer.from(value, 'base64url').toString('utf8')).sub });
    }
    send(response, 404, { error: 'not_found' });
  }).listen(9443, () => console.log(`fake Oathweave ${issuer}`));
}

const [command, subject] = process.argv.slice(2);
if (command === 'serve') serve();
else if ((command === 'token' || command === 'service') && subject) console.log(token(subject, command === 'service' ? 'service' : 'user'));
else { console.error('Usage: fake-suite.mjs serve | token <subject> | service <client>'); process.exit(2); }
