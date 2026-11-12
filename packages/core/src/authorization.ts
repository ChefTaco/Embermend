import { z } from 'zod';
import { scanRequestSchema, sourceRequestSchema, preparationSchema, type Actor, type Scope, type Permission, type Plan, type Action, type Policy, type Entity } from '@hivemagnus/embermend-contracts';
import { within } from '@hivemagnus/embermend-store';

export class DomainError extends Error { constructor(public readonly code: string, public readonly status = 409) { super(code); } }
export function requirePermission(actor: Actor, permission: Permission, scope: Scope): void {
  if (!actor.permissions.has(permission) || !within(actor.scope, scope)) throw new DomainError('SCOPE_OR_PERMISSION_DENIED', 403);
  if (['approve', 'policy', 'exception', 'recover'].includes(permission) && actor.kind !== 'operator') throw new DomainError('OPERATOR_AUTHORITY_REQUIRED', 403);
}
export function requireActionPermission(actor: Actor, action: Action, scope: Scope): void {
  const permission: Permission = action.class === 'repository-write' ? 'repository-write' : action.class === 'merge' ? 'merge' : action.class === 'artifact-publish' ? 'artifact-publish' : action.class === 'deploy' ? 'deploy' : action.class === 'recovery' ? 'recover' : action.class === 'exception' ? 'exception' : action.class === 'prepare' || action.class === 'build' ? 'prepare' : action.class === 'assess' ? 'assess' : 'execute';
  requirePermission(actor, permission, scope);
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().min(1).max(200);
const packageName = z.string().regex(/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/);
const packageSpec = z.object({ name: packageName, version: z.string().min(1).max(200).regex(/^[A-Za-z0-9.+:~_-]+$/) }).strict();
export const parameterSchemas = {
  'image-vulnerabilities.v1': z.object({ imageRef: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/) }).strict(),
  'ubuntu-oval.v1': z.object({}).strict(),
  'inventory.v1': z.object({ sections: z.array(z.enum(['packages', 'services', 'listeners', 'configuration', 'docker', 'compose', 'oval'])).min(1), profileId: ref }).strict(),
  'security-update.v1': z.object({ packages: z.array(packageSpec).min(1).max(200), previewDigest: hash, allowDependencyChanges: z.boolean(), allowServiceRestarts: z.boolean() }).strict(),
  'security-update-preview.v1': z.object({ packages: z.array(packageSpec).min(1).max(200) }).strict(),
  'file-mode.v1': z.object({ resourceId: ref, mode: z.enum(['0600', '0640', '0700', '0750']), beforeDigest: hash }).strict(),
  'ssh-policy.v1': z.object({ resourceId: ref, permitRootLogin: z.enum(['no', 'prohibit-password']), passwordAuthentication: z.boolean(), beforeDigest: hash, managementProbeId: ref }).strict(),
  'firewall-rule.v1': z.object({ resourceId: ref, protocol: z.enum(['tcp', 'udp']), port: z.number().int().min(1).max(65535), sourceCidr: ref, allow: z.boolean(), beforeDigest: hash, managementProbeId: ref }).strict(),
  'service-state.v1': z.object({ resourceId: ref, enabled: z.boolean(), active: z.boolean(), beforeDigest: hash }).strict(),
  'repository-scan.v1': z.object({ request: scanRequestSchema }).strict(),
  'repository-source.v1': z.object({ request: sourceRequestSchema }).strict(),
  'repository-prepare.v1': z.object({ request: preparationSchema }).strict(),
  'repository-validate.v1': z.object({ workspaceId: ref, validationProfileId: ref, patchDigest: hash }).strict(),
  'repository-pr.v1': z.object({ changeId: ref, repositoryId: ref, baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/), patchDigest: hash }).strict(),
  'repository-merge.v1': z.object({ changeId: ref, headCommit: z.string().regex(/^[a-f0-9]{40,64}$/), checksDigest: hash }).strict(),
  'artifact-build.v1': z.object({ repositoryId: ref, sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/), buildProfileId: ref, workspaceId: ref }).strict(),
  'artifact-publish.v1': z.object({ artifactId: ref, digest: hash, destinationId: ref }).strict(),
  'compose-deploy.v1': z.object({ deploymentId: ref, artifactDigest: hash, configurationDigest: hash, beforeDigest: hash }).strict(),
  'restart-service.v1': z.object({ resourceId: ref, beforeDigest: hash }).strict(),
  'reboot.v1': z.object({ beforeBootId: ref, managementProbeId: ref }).strict(),
  'configuration-recover.v1': z.object({ originalOperationId: ref, recoveryArtifactId: ref, beforeDigest: hash }).strict(),
  'execution-settle.v1': z.object({ originalOperationId: ref, originalRequestDigest: hash, nativeCommandId: ref, nativeRequestDigest: hash, evidenceId: ref, evidenceDigest: hash, disposition: z.enum(['effects_verified', 'no_effect_verified']), originalOutcome: z.literal('unknown') }).strict(),
} as const;
const definitions = {
  'image-vulnerabilities.v1': { class: 'assess', kinds: ['host'] },
  'ubuntu-oval.v1': { class: 'assess', kinds: ['host'] },
  'inventory.v1': { class: 'assess', kinds: ['host', 'worker', 'container'] },
  'security-update.v1': { class: 'host-change', kinds: ['host'] },
  'security-update-preview.v1': { class: 'assess', kinds: ['host'] },
  'file-mode.v1': { class: 'host-change', kinds: ['host'] },
  'ssh-policy.v1': { class: 'host-change', kinds: ['host'] },
  'firewall-rule.v1': { class: 'host-change', kinds: ['host'] },
  'service-state.v1': { class: 'host-change', kinds: ['host'] },
  'repository-scan.v1': { class: 'assess', kinds: ['worker'] },
  'repository-source.v1': { class: 'assess', kinds: ['worker'] },
  'repository-prepare.v1': { class: 'prepare', kinds: ['worker'] },
  'repository-validate.v1': { class: 'prepare', kinds: ['worker'] },
  'repository-pr.v1': { class: 'repository-write', kinds: ['repository'] },
  'repository-merge.v1': { class: 'merge', kinds: ['repository'] },
  'artifact-build.v1': { class: 'build', kinds: ['worker'] },
  'artifact-publish.v1': { class: 'artifact-publish', kinds: ['worker'] },
  'compose-deploy.v1': { class: 'deploy', kinds: ['host'] },
  'restart-service.v1': { class: 'restart', kinds: ['host', 'container'] },
  'reboot.v1': { class: 'reboot', kinds: ['host'] },
  'configuration-recover.v1': { class: 'recovery', kinds: ['host'] },
  'execution-settle.v1': { class: 'recovery', kinds: ['host'] },
} as const;
export type ActionVersion = keyof typeof parameterSchemas;
export const actionVersionSchema = z.enum(['image-vulnerabilities.v1', 'ubuntu-oval.v1', 'inventory.v1', 'security-update.v1', 'security-update-preview.v1', 'file-mode.v1', 'ssh-policy.v1', 'firewall-rule.v1', 'service-state.v1', 'repository-source.v1', 'repository-scan.v1', 'repository-prepare.v1', 'repository-validate.v1', 'repository-pr.v1', 'repository-merge.v1', 'artifact-build.v1', 'artifact-publish.v1', 'compose-deploy.v1', 'restart-service.v1', 'reboot.v1', 'configuration-recover.v1', 'execution-settle.v1']);
export function validateAction(action: Action): void {
  if (Buffer.byteLength(JSON.stringify({ actionJson: JSON.stringify(action) })) > 80 * 1024) throw new DomainError('ACTION_EXCEEDS_MANAGED_REQUEST_BUDGET', 413);
  const version = actionVersionSchema.parse(action.version); const definition = definitions[version];
  if (definition.class !== action.class || !definition.kinds.some(kind => kind === action.targetKind)) throw new DomainError('ACTION_EFFECT_OR_TARGET_MISMATCH');
  parameterSchemas[version].parse(action.parameters);
  const rank = { none: 0, restart: 1, reboot: 2, outage: 3 };
  const minimum = version === 'reboot.v1' ? 2 : version === 'firewall-rule.v1' && action.parameters['allow'] === false || version === 'service-state.v1' && action.parameters['active'] === false || version === 'compose-deploy.v1' ? 3 : ['security-update.v1', 'ssh-policy.v1', 'service-state.v1', 'restart-service.v1', 'configuration-recover.v1'].includes(version) ? 1 : 0;
  if (rank[action.disruption] < minimum) throw new DomainError('ACTION_IMPACT_UNDERSTATED');
  if (!action.requiredCapabilities.includes(`embermend:${version}`)) throw new DomainError('REQUIRED_ACTION_CAPABILITY_MISSING');
}
export function policyCovers(policy: Policy, plan: Plan, targets: readonly Entity[], now = new Date(), verifiedRecoveryActions: ReadonlySet<string> = new Set()): boolean {
  if (!policy.enabled || !within(policy.scope, plan.scope) || Date.parse(policy.notBefore) > now.getTime() || Date.parse(policy.expiresAt) <= now.getTime()) return false;
  if (new Set(plan.actions.map(action => action.targetId)).size > policy.maxTargets) return false;
  return plan.actions.every(action => {
    if (action.version === 'execution-settle.v1') return false;
    if (!policy.actionVersions?.includes(action.version) || !policy.actionClasses.includes(action.class) || !policy.disruptions.includes(action.disruption)) return false;
    const environment = action.preconditions['environment'];
    if (typeof environment !== 'string' || environment === 'unknown' || !policy.environments.includes(environment)) return false;
    if (['repository-write', 'merge', 'prepare', 'build'].includes(action.class)) {
      const branch = action.preconditions['branch']; if (typeof branch !== 'string' || !policy.branches.includes(branch)) return false;
    }
    if (policy.requireVerifiedRecovery && !verifiedRecoveryActions.has(action.id)) return false;
    return targets.some(target => target.id === action.targetId && (target.kind === 'repository' ? target.scope.installationId === policy.scope.installationId && plan.scope.applicationIds.some(id => target.scope.applicationIds.includes(id)) : within(policy.scope, target.scope)) && (target.kind === 'target' || target.kind === 'repository') && (target.environment ?? 'unknown') === environment);
  });
}
export function assertTarget(action: Action, target: Entity, now = new Date()): void {
  validateAction(action);
  if (action.targetId !== target.id) throw new DomainError('TARGET_IDENTITY_MISMATCH');
  if (!['assess', 'prepare'].includes(action.class) && (target.kind !== 'target' && target.kind !== 'repository' || action.preconditions['environment'] !== (target.environment ?? 'unknown'))) throw new DomainError('AUTHORITATIVE_ENVIRONMENT_MISMATCH');
  if (action.targetKind === 'repository') { if (target.kind !== 'repository') throw new DomainError('REPOSITORY_TARGET_REQUIRED'); return; }
  if (target.kind !== 'target' || !(target.targetKind === action.targetKind || target.targetKind === 'host' && action.targetKind === 'worker') || target.lifecycle !== 'active' || target.enrollment !== 'enrolled' || (now.getTime() - Date.parse(target.lastSeenAt) > 120000 || now.getTime() - Date.parse(target.lastSeenAt) < -120000)) throw new DomainError('TARGET_NOT_ELIGIBLE');
  if (!action.requiredCapabilities.every(capability => target.capabilities.includes(capability))) throw new DomainError('TARGET_CAPABILITY_UNAVAILABLE');
  if (target.targetKind === 'container' && ['host-change', 'reboot', 'deploy'].includes(action.class)) throw new DomainError('CONTAINER_CANNOT_MANAGE_HOST');
}
