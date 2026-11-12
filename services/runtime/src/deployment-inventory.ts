import { z } from 'zod';
import { type Actor, type Evidence } from '@hivemagnus/embermend-contracts';
import { digest } from '@hivemagnus/embermend-store';
import { type Embermend } from '@hivemagnus/embermend-core';
const instanceSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), imageRef: z.string(), status: z.string(), running: z.boolean(), health: z.string().nullable(), startedAt: z.iso.datetime({ offset: true }), service: z.string(), project: z.string() }).strict();
const resourceSchema = z.object({ configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), beforeDigest: z.string().regex(/^[a-f0-9]{64}$/), instances: z.array(instanceSchema).max(100), observedAt: z.iso.datetime({ offset: true }) }).strict();
/** Native inventory establishes current instances, never security closure. */
export async function reconcileDeploymentInventory(service: Embermend, actor: Actor, evidence: Evidence): Promise<unknown[]> {
  const entities = await service.entities(actor); const target = entities.find(entity => entity.id === evidence.subjectId && entity.kind === 'target');
  if (!target || target.kind !== 'target' || evidence.source !== 'magnus') return [];
  const resources = z.record(z.string(), z.unknown()).safeParse(evidence.content['resources']);
  const snapshots = [];
  for (const deployment of entities) {
    if (deployment.kind !== 'deployment' || !deployment.targetIds.includes(target.id)) continue;
    const parsed = resourceSchema.safeParse(resources.success ? resources.data[deployment.magnusResourceId ?? deployment.id] : undefined); const instances = []; const artifactIds = new Set<string>(); let unknown = 0;
    const capturedAt = parsed.success ? parsed.data.observedAt : evidence.observedAt;
    const applicable = parsed.success && parsed.data.configurationDigest === deployment.configurationDigest && Date.parse(capturedAt) <= Date.now() + 120000;
    if (parsed.success && applicable) {
      for (const instance of parsed.data.instances) {
        const artifact = entities.find(entity => entity.kind === 'artifact' && entity.image === instance.imageRef);
        if (!artifact || artifact.kind !== 'artifact') { unknown++; continue; }
        const id = digest(['container-instance', target.id, deployment.id, instance.id, instance.startedAt]);
        const provenance = { source: 'magnus-compose-inventory', assurance: 'established' as const, evidenceIds: [evidence.id], observedAt: capturedAt };
        await service.entity(actor, { id, kind: 'container-instance', scope: deployment.scope, label: deployment.label + ' container instance', provenance, runtimeId: instance.id, deploymentId: deployment.id, artifactId: artifact.id, hostId: target.id, agentId: target.agentId, startedAt: instance.startedAt });
        for (const [fromId, toId, kind] of [[deployment.id, id, 'deployed-as'], [id, artifact.id, 'built-from'], [id, target.id, 'runs-on'], [id, target.agentId, 'managed-by']]) {
          if (!fromId || !toId || !kind) throw new Error('Deployment relationship required');
          await service.records.relationship(actor, { id: digest([fromId, toId, kind, evidence.id]), scope: deployment.scope, fromId, toId, kind, provenance });
        }
        artifactIds.add(artifact.id); instances.push({ id, runtimeId: instance.id, artifactId: artifact.id, running: instance.running, health: instance.health });
      }
      if (Date.parse(capturedAt) >= Date.parse(deployment.provenance.observedAt)) await service.entity(actor, { ...deployment, artifactIds: [...artifactIds], provenance: { source: 'magnus-compose-inventory', assurance: unknown ? 'unknown' : 'established', evidenceIds: [evidence.id], observedAt: capturedAt } });
    }
    const status = !applicable ? 'not-assessed' : unknown || !instances.length ? 'partial' : 'complete';
    const id = digest(['deployment-inventory', deployment.id, evidence.id]);
    await service.records.observation(actor, { id, scope: deployment.scope, source: 'magnus-compose-inventory', sourceEventId: id, subjectId: deployment.id, type: 'deployment-' + status, observedAt: capturedAt, evidenceIds: [evidence.id], data: {} });
    snapshots.push({ deploymentId: deployment.id, coverage: status, instances, unknownInstances: unknown, securityVerification: 'outstanding' });
  }
  return snapshots;
}
