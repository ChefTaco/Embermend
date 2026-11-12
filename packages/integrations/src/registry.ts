import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const descriptor = z.object({ mediaType: z.string(), digest, size: z.number().int().min(0).max(512 * 1024 * 1024) });
const indexType = 'application/vnd.oci.image.index.v1+json';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const manifest = z.object({ schemaVersion: z.literal(2), mediaType: z.literal(manifestType), config: descriptor, layers: z.array(descriptor).max(200) });
const index = z.object({ schemaVersion: z.literal(2), mediaType: z.literal(indexType), manifests: z.array(descriptor).min(1).max(30) });
const artifactSchema = z.object({ artifactId: z.string().min(1), artifactDigest: hash, sourceCommits: z.array(z.string().regex(/^[a-f0-9]{40,64}$/)).min(1), reviewEvidenceId: z.string().min(1), archiveDigest: hash, layoutPath: z.string().refine(isAbsolute) }).strict();
const destinationSchema = z.object({ id: z.string().min(1), origin: z.url(), repository: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/), imageHost: z.string().regex(/^[a-z0-9.-]+(?::[0-9]{1,5})?$/).optional(), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/).optional() }).strict();
const configSchema = z.object({ artifacts: z.array(artifactSchema), destinations: z.array(destinationSchema) }).strict();
export const publicationDescriptorSchema = artifactSchema.omit({ layoutPath: true }).extend({ destinationId: z.string(), imageRef: z.string() }).strict();
export type PublicationDescriptor = z.infer<typeof publicationDescriptorSchema>;
export const publicationResultSchema = publicationDescriptorSchema.extend({ providerOperationId: z.string() }).strict();
export type PublicationResult = z.infer<typeof publicationResultSchema>;
export interface ArtifactPublisher {
  describe(artifactId: string, artifactDigest: string, destinationId: string): PublicationDescriptor;
  validate(expected: PublicationDescriptor): Promise<void>;
  publish(expected: PublicationDescriptor): Promise<PublicationResult>;
  observe(expected: PublicationDescriptor): Promise<PublicationResult | null>;
}
type ObjectBytes = { digest: string; bytes: Buffer; mediaType: string; isManifest: boolean };
const sha = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

/** Protected, independently reviewed OCI layouts only. Never executes repository code. */
export class OciRegistryPublisher implements ArtifactPublisher {
  private readonly config: z.infer<typeof configSchema>;
  constructor(raw: unknown, private readonly environment: Readonly<Record<string, string | undefined>>, private readonly request: typeof fetch = fetch) {
    this.config = configSchema.parse(raw);
    if (new Set(this.config.artifacts.map(a => a.artifactId)).size !== this.config.artifacts.length || new Set(this.config.destinations.map(d => d.id)).size !== this.config.destinations.length) throw new Error('PUBLICATION_CATALOG_IDENTITY_CONFLICT');
    for (const destination of this.config.destinations) {
      const url = new URL(destination.origin);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('PUBLICATION_REGISTRY_ORIGIN_REQUIRED');
      if (destination.imageHost && new URL('https://' + destination.imageHost).host !== destination.imageHost) throw new Error('PUBLICATION_IMAGE_HOST_REQUIRED');
      if (destination.tokenEnv && !environment[destination.tokenEnv]) throw new Error('PUBLICATION_REGISTRY_CREDENTIAL_REQUIRED');
    }
  }
  describe(artifactId: string, artifactDigest: string, destinationId: string): PublicationDescriptor {
    const artifact = this.config.artifacts.find(a => a.artifactId === artifactId && a.artifactDigest === artifactDigest);
    const destination = this.config.destinations.find(d => d.id === destinationId);
    if (!artifact || !destination) throw new Error('REVIEWED_PUBLICATION_CATALOG_ENTRY_REQUIRED');
    const { layoutPath: _layout, ...review } = artifact;
    return { ...review, sourceCommits: [...review.sourceCommits], destinationId, imageRef: (destination.imageHost ?? new URL(destination.origin).host) + '/' + destination.repository + '@sha256:' + artifactDigest };
  }
  private bound(expected: PublicationDescriptor) {
    const actual = this.describe(expected.artifactId, expected.artifactDigest, expected.destinationId);
    if (JSON.stringify(actual) !== JSON.stringify(publicationDescriptorSchema.parse(expected))) throw new Error('PUBLICATION_REVIEW_CHANGED');
    const artifact = this.config.artifacts.find(a => a.artifactId === actual.artifactId);
    const destination = this.config.destinations.find(d => d.id === actual.destinationId);
    if (!artifact || !destination) throw new Error('PUBLICATION_CATALOG_ENTRY_MISSING');
    return { artifact, destination, actual };
  }
  private async objects(expected: PublicationDescriptor): Promise<ObjectBytes[]> {
    const { artifact } = this.bound(expected);
    if (await realpath(artifact.layoutPath) !== artifact.layoutPath || !(await lstat(artifact.layoutPath)).isDirectory()) throw new Error('CANONICAL_OCI_LAYOUT_REQUIRED');
    const objects: ObjectBytes[] = []; const seen = new Map<string, string>(); let total = 0;
    const visit = async (reference: z.infer<typeof descriptor>, isManifest: boolean, root = false): Promise<void> => {
      const identity = JSON.stringify([reference.size, reference.mediaType, isManifest]); const prior = seen.get(reference.digest);
      if (prior) { if (prior !== identity) throw new Error('OCI_DESCRIPTOR_CONFLICT'); return; }
      seen.set(reference.digest, identity); if (seen.size > 1000) throw new Error('OCI_OBJECT_BUDGET_EXCEEDED');
      const path = join(artifact.layoutPath, 'blobs', 'sha256', reference.digest.slice(7));
      if (await realpath(path) !== path) throw new Error('OCI_SYMLINK_REFUSED');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes: Buffer;
      try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024 * 1024 || !root && stat.size !== reference.size) throw new Error('OCI_OBJECT_SIZE_OR_KIND_CHANGED'); total += stat.size; if (total > 1024 * 1024 * 1024) throw new Error('OCI_BYTE_BUDGET_EXCEEDED'); bytes = await file.readFile(); } finally { await file.close(); }
      if ('sha256:' + sha(bytes) !== reference.digest) throw new Error('OCI_OBJECT_DIGEST_MISMATCH');
      if (isManifest) {
        if (bytes.length > 1024 * 1024) throw new Error('OCI_MANIFEST_BUDGET_EXCEEDED');
        const raw: unknown = JSON.parse(bytes.toString('utf8'));
        if (reference.mediaType === indexType) { for (const child of index.parse(raw).manifests) await visit(child, true); }
        else { const value = manifest.parse(raw); await visit(value.config, false); for (const layer of value.layers) await visit(layer, false); }
      }
      objects.push({ digest: reference.digest, bytes, mediaType: reference.mediaType, isManifest });
    };
    // The approved root is itself content addressed. Children include provenance
    // and SBOM manifests; copying never converts or drops an attestation.
    await visit({ digest: 'sha256:' + expected.artifactDigest, size: 0, mediaType: indexType }, true, true);
    return objects;
  }
  private async exchange(expected: PublicationDescriptor, path: string | URL, method: string, bytes?: Buffer, mediaType?: string): Promise<Response> {
    const { destination } = this.bound(expected); const url = new URL(path, destination.origin);
    if (url.origin !== new URL(destination.origin).origin || !url.pathname.startsWith('/v2/' + destination.repository + '/') || url.username || url.password) throw new Error('REGISTRY_OPERATION_OUTSIDE_DESTINATION');
    const token = destination.tokenEnv ? this.environment[destination.tokenEnv] : undefined;
    return this.request(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(mediaType ? { 'content-type': mediaType } : {}), accept: indexType + ', ' + manifestType }, ...(bytes ? { body: new Uint8Array(bytes) } : {}) });
  }
  async validate(expected: PublicationDescriptor): Promise<void> { await this.objects(expected); }
  async publish(expected: PublicationDescriptor): Promise<PublicationResult> {
    const { destination, actual } = this.bound(expected); const objects = await this.objects(actual); const base = '/v2/' + destination.repository;
    for (const object of objects) {
      if (object.isManifest) {
        const response = await this.exchange(actual, base + '/manifests/' + object.digest, 'PUT', object.bytes, object.mediaType);
        if (response.status !== 201 || response.headers.get('docker-content-digest') !== object.digest) throw new Error('REGISTRY_MANIFEST_PUBLICATION_UNCONFIRMED');
      } else {
        const head = await this.exchange(actual, base + '/blobs/' + object.digest, 'HEAD');
        if (head.status === 200) { if (head.headers.get('docker-content-digest') !== object.digest) throw new Error('REGISTRY_BLOB_IDENTITY_CHANGED'); continue; }
        if (head.status !== 404) throw new Error('REGISTRY_BLOB_OBSERVATION_FAILED');
        const upload = await this.exchange(actual, base + '/blobs/uploads/', 'POST'); const location = upload.headers.get('location');
        if (upload.status !== 202 || !location) throw new Error('REGISTRY_UPLOAD_UNCONFIRMED');
        const url = new URL(location, destination.origin);
        const uploadPrefix = base + '/blobs/uploads/';
        if (!url.pathname.startsWith(uploadPrefix) || !/^[A-Za-z0-9_-]+$/.test(url.pathname.slice(uploadPrefix.length)) || url.hash) throw new Error('REGISTRY_UPLOAD_LOCATION_REFUSED');
        url.searchParams.set('digest', object.digest);
        const stored = await this.exchange(actual, url, 'PUT', object.bytes, 'application/octet-stream');
        if (stored.status !== 201 || stored.headers.get('docker-content-digest') !== object.digest) throw new Error('REGISTRY_BLOB_PUBLICATION_UNCONFIRMED');
      }
    }
    const result = await this.observeObjects(actual, objects); if (!result) throw new Error('REGISTRY_PUBLICATION_OUTCOME_UNKNOWN'); return result;
  }
  async observe(expected: PublicationDescriptor): Promise<PublicationResult | null> {
    return this.observeObjects(expected, await this.objects(expected));
  }
  private async observeObjects(expected: PublicationDescriptor, objects: readonly ObjectBytes[]): Promise<PublicationResult | null> {
    const { destination, actual } = this.bound(expected); const base = '/v2/' + destination.repository;
    const root = await this.exchange(actual, base + '/manifests/sha256:' + actual.artifactDigest, 'HEAD'); if (root.status === 404) return null;
    if (root.status !== 200 || root.headers.get('docker-content-digest') !== 'sha256:' + actual.artifactDigest) throw new Error('REGISTRY_PUBLICATION_OBSERVATION_FAILED');
    for (const object of objects) {
      const response = await this.exchange(actual, base + (object.isManifest ? '/manifests/' : '/blobs/') + object.digest, object.isManifest ? 'GET' : 'HEAD');
      if (response.status !== 200 || response.headers.get('docker-content-digest') !== object.digest) throw new Error('REGISTRY_PUBLICATION_INCOMPLETE');
      if (object.isManifest) {
        const reader = response.body?.getReader(); if (!reader) throw new Error('REGISTRY_MANIFEST_BODY_REQUIRED');
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > object.bytes.length) { await reader.cancel(); throw new Error('REGISTRY_MANIFEST_SIZE_CHANGED'); } chunks.push(chunk.value); }
        if (size !== object.bytes.length || 'sha256:' + sha(Buffer.concat(chunks)) !== object.digest) throw new Error('REGISTRY_MANIFEST_DIGEST_CHANGED');
      }
    }
    return { ...actual, providerOperationId: actual.imageRef };
  }
}
