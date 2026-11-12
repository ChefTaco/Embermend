import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OciRegistryPublisher } from '@hivemagnus/embermend-integrations';

const indexType = 'application/vnd.oci.image.index.v1+json'; const manifestType = 'application/vnd.oci.image.manifest.v1+json';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'embermend-publication-')); await mkdir(join(root, 'blobs', 'sha256'), { recursive: true });
  const objects = new Map<string, Buffer>();
  const put = async (raw: unknown, mediaType: string) => { const bytes = Buffer.from(JSON.stringify(raw)); const hash = createHash('sha256').update(bytes).digest('hex'); objects.set('sha256:' + hash, bytes); await writeFile(join(root, 'blobs', 'sha256', hash), bytes, { mode: 0o600 }); return { mediaType, digest: 'sha256:' + hash, size: bytes.length }; };
  const platforms = [];
  for (const architecture of ['amd64', 'arm64']) {
    const config = await put({ architecture, os: 'linux' }, 'application/vnd.oci.image.config.v1+json');
    const layer = await put({ fictionalLayer: architecture }, 'application/vnd.oci.image.layer.v1.tar');
    platforms.push({ ...await put({ schemaVersion: 2, mediaType: manifestType, config, layers: [layer] }, manifestType), platform: { architecture, os: 'linux' } });
  }
  const config = await put({}, 'application/vnd.oci.image.config.v1+json');
  const sbom = await put({ predicateType: 'https://spdx.dev/Document', predicate: { fictional: true } }, 'application/vnd.in-toto+json');
  const attestation = await put({ schemaVersion: 2, mediaType: manifestType, config, layers: [sbom] }, manifestType);
  const index = await put({ schemaVersion: 2, mediaType: indexType, manifests: [...platforms, { ...attestation, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }] }, indexType);
  const artifact = { artifactId: 'fixture-artifact', artifactDigest: index.digest.slice(7), sourceCommits: ['a'.repeat(40)], reviewEvidenceId: 'fixture-review', archiveDigest: 'b'.repeat(64), layoutPath: root };
  const destination = { id: 'fixture-registry', origin: 'https://registry.example.com', repository: 'fixture/catalog', imageHost: 'images.example.com', tokenEnv: 'FIXTURE_REGISTRY_TOKEN' };
  const calls: { method: string; path: string }[] = []; const stored = new Map<string, Buffer>(); let badLocation = false; let loseRootReply = false;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET'; calls.push({ method, path: url.pathname });
    assert.equal(url.origin, destination.origin); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-private-token'); assert.equal(init?.redirect, 'error');
    if (method === 'POST') return new Response(null, { status: 202, headers: { location: badLocation ? 'https://attacker.example.com/v2/fixture/catalog/blobs/uploads/1' : '/v2/fixture/catalog/blobs/uploads/1?state=fixture-state' } });
    const hash = url.searchParams.get('digest') ?? url.pathname.split('/').at(-1); assert.ok(hash);
    if (method === 'PUT') { assert.ok(init?.body instanceof Uint8Array); const body = Buffer.from(init.body); assert.equal('sha256:' + createHash('sha256').update(body).digest('hex'), hash); stored.set(hash, body); if (hash === index.digest && loseRootReply) throw new Error('Lost root publication reply'); return new Response(null, { status: 201, headers: { 'docker-content-digest': hash } }); }
    const bytes = stored.get(hash); return new Response(method === 'HEAD' || !bytes ? null : new Uint8Array(bytes), { status: bytes ? 200 : 404, headers: bytes ? { 'docker-content-digest': hash } : {} });
  };
  const client = new OciRegistryPublisher({ artifacts: [artifact], destinations: [destination] }, { FIXTURE_REGISTRY_TOKEN: 'fixture-private-token' }, request);
  return { root, objects, artifact, destination, client, calls, stored, badLocation: () => { badLocation = true; }, loseRootReply: () => { loseRootReply = true; }, expected: client.describe(artifact.artifactId, artifact.artifactDigest, destination.id) };
}
test('reviewed OCI publication preserves both platforms, attestations and exact content-addressed identities', async () => {
  const f = await fixture(); try {
    assert.equal(await f.client.observe(f.expected), null); f.calls.length = 0;
    const exposed = f.client.describe(f.artifact.artifactId, f.artifact.artifactDigest, f.destination.id); exposed.sourceCommits.push('c'.repeat(40)); assert.equal(f.client.describe(f.artifact.artifactId, f.artifact.artifactDigest, f.destination.id).sourceCommits.length, 1);
    const result = await f.client.publish(f.expected); assert.equal(result.providerOperationId, 'images.example.com/fixture/catalog@sha256:' + f.artifact.artifactDigest);
    assert.deepEqual([...f.stored.keys()].sort(), [...f.objects.keys()].sort()); for (const [hash, bytes] of f.objects) assert.deepEqual(f.stored.get(hash), bytes);
    assert.ok(f.calls.filter(c => c.method === 'PUT' && c.path.includes('/manifests/')).every(c => c.path.includes('/manifests/sha256:')));
    assert.equal(f.calls.filter(c => c.method === 'PUT').at(-1)?.path, '/v2/fixture/catalog/manifests/sha256:' + f.artifact.artifactDigest);
    f.calls.length = 0; assert.deepEqual(await f.client.observe(f.expected), result); assert.ok(f.calls.every(c => ['GET', 'HEAD'].includes(c.method)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('a lost publication reply is adopted through original digest reads without repeating a write', async () => {
  const f = await fixture(); try { f.loseRootReply(); await assert.rejects(f.client.publish(f.expected), /Lost root/); const writes = f.calls.filter(c => ['POST', 'PUT'].includes(c.method)).length; const result = await f.client.observe(f.expected); assert.equal(result?.artifactDigest, f.artifact.artifactDigest); assert.equal(f.calls.filter(c => ['POST', 'PUT'].includes(c.method)).length, writes); } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('changed bytes, linked objects and changed review metadata are refused before registry writes', async () => {
  for (const kind of ['bytes', 'link', 'review']) {
    const f = await fixture(); try {
      const hash = [...f.objects.keys()][0]; assert.ok(hash); const path = join(f.root, 'blobs', 'sha256', hash.slice(7));
      if (kind === 'bytes') await writeFile(path, 'corrupt');
      if (kind === 'link') { await rm(path); await symlink('/etc/passwd', path); }
      const expected = kind === 'review' ? { ...f.expected, archiveDigest: 'c'.repeat(64) } : f.expected;
      await assert.rejects(f.client.publish(expected)); assert.equal(f.calls.length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
test('registry upload destinations and credential availability cannot be broadened by responses or plans', async () => {
  const f = await fixture(); try {
    assert.throws(() => new OciRegistryPublisher({ artifacts: [f.artifact], destinations: [f.destination] }, {}), /CREDENTIAL_REQUIRED/);
    assert.throws(() => new OciRegistryPublisher({ artifacts: [f.artifact], destinations: [{ ...f.destination, origin: 'http://192.0.2.1' }] }, { FIXTURE_REGISTRY_TOKEN: 'fixture-token' }), /ORIGIN_REQUIRED/);
    assert.throws(() => f.client.describe('outside-artifact', f.artifact.artifactDigest, f.destination.id), /CATALOG_ENTRY_REQUIRED/);
    f.badLocation(); await assert.rejects(f.client.publish(f.expected), /OUTSIDE_DESTINATION/); assert.ok(f.calls.every(c => c.method !== 'PUT'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
