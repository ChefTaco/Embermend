import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSchema, type Verification } from '@hivemagnus/embermend-contracts';
import { requirePermission, policyCovers, validateAction, assertTarget, verifiedOccurrence } from '@hivemagnus/embermend-core';
import { redact, redactObject, endpoint } from '@hivemagnus/embermend-integrations';
import { plan, policy, target, operator, coordinator, scope, evidence, finding, occurrence, coverage, now, hash, commit } from './fixtures.js';

test('coordinator cannot approve, edit policy, accept exceptions, or authorize recovery', () => {
  for (const permission of ['approve', 'policy', 'exception', 'recover'] as const) assert.throws(() => requirePermission({ ...coordinator, permissions: new Set([permission]) }, permission, scope), /OPERATOR_AUTHORITY/);
});
test('scope grants are explicit and installation-bound', () => {
  assert.throws(() => requirePermission(operator, 'read', { ...scope, targetIds: ['another-node'] }), /DENIED/);
  assert.throws(() => requirePermission(operator, 'read', { ...scope, installationId: 'another-installation' }), /DENIED/);
});
test('plan dependencies are acyclic and targets cannot expand scope', () => {
  const value = plan(); const action = value.actions[0]; assert.ok(action); action.dependsOn = [action.id]; assert.equal(planSchema.safeParse(value).success, false);
  action.dependsOn = []; action.targetId = 'outside-node'; assert.equal(planSchema.safeParse(value).success, false);
});
test('action implementations cannot be substituted or misdeclare their effect', () => {
  const action = plan().actions[0]; assert.ok(action); validateAction(action);
  assert.throws(() => validateAction({ ...action, class: 'assess' }), /MISMATCH/);
  assert.throws(() => validateAction({ ...action, parameters: { ...action.parameters, command: 'arbitrary shell' } }));
  assert.throws(() => validateAction({ ...action, version: 'generated-script.v1' }));
});
test('standing policies bind environment, disruption, recovery, targets, and time', () => {
  assert.equal(policyCovers(policy(), plan(), [target()]), true);
  assert.equal(policyCovers({ ...policy(), environments: ['production'] }, plan(), [target()]), false);
  assert.equal(policyCovers({ ...policy(), enabled: false }, plan(), [target()]), false);
  assert.equal(policyCovers(policy(), plan(), []), false);
  assert.equal(policyCovers({ ...policy(), requireVerifiedRecovery: true }, plan(), [target()]), false, 'AI-supplied recoveryVerified does not establish recovery evidence');
});
test('offline, stale, unsupported, and container-scoped targets cannot receive host changes', () => {
  const action = plan().actions[0]; const node = target(); assert.ok(action); assert.equal(node.kind, 'target'); if (node.kind !== 'target') return;
  assertTarget(action, node);
  for (const modified of [{ ...node, lastSeenAt: '2020-01-01T00:00:00Z' }, { ...node, capabilities: [] }, { ...node, targetKind: 'container' as const }]) assert.throws(() => assertTarget(action, modified));
});
test('publication standing policy retains branch and application bounds for shared repository identity', () => {
  const original = plan(); const first = original.actions[0]; assert.ok(first);
  const repository = { id: 'fixture-repository', kind: 'repository' as const, scope: { ...scope, applicationIds: [], targetIds: [] }, label: 'Fixture repository', provenance: { source: 'fixture', assurance: 'established' as const, evidenceIds: [], observedAt: now() }, provider: 'github' as const, providerInstance: 'https://github.com', providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', environment: 'lab', accessRevision: 1 };
  const proposed = { ...original, canaryTargetId: repository.id, actions: [{ ...first, targetId: repository.id, targetKind: 'repository' as const, version: 'artifact-publish.v1', class: 'artifact-publish' as const, requiredCapabilities: ['embermend:artifact-publish.v1'], parameters: { artifactId: 'fixture-artifact', digest: hash, destinationId: 'fixture-registry' }, preconditions: { environment: 'lab', branch: 'main' }, expectedRevision: commit }] };
  const allowed = { ...policy(), actionVersions: ['artifact-publish.v1'], actionClasses: ['artifact-publish' as const], branches: ['main'] };
  assert.equal(policyCovers(allowed, proposed, [repository]), true);
  assert.equal(policyCovers({ ...allowed, branches: ['other'] }, proposed, [repository]), false);
  assert.equal(policyCovers({ ...allowed, scope: { ...scope, applicationIds: ['another-app'] } }, proposed, [repository]), false);
});
const verification = (): Verification => ({ id: 'fixture-verification', occurrenceId: 'fixture-occurrence', dimension: 'runtime', result: 'pass', method: 'permissions-check.v1', evidenceIds: ['fixture-evidence'], coverage: coverage(), revision: null, artifactDigest: hash, targetId: 'fixture-node', healthPassed: true, observedAt: now(), independent: true, consumerMigrationVerified: false });
test('runtime closure requires deployed artifact, independent security reassessment, and health', () => {
  assert.throws(() => verifiedOccurrence({ ...finding(), kind: 'image' }, occurrence(), verification(), [evidence()]), /ARTIFACT_PROOF/);
  const proof = { ...evidence(), content: { deployedArtifactDigest: hash, securityCheckPassed: true, findingIdentity: hash } };
  assert.equal(verifiedOccurrence({ ...finding(), kind: 'image' }, occurrence(), verification(), [proof]).runtimeState, 'verified-resolved');
  for (const modified of [{ ...verification(), independent: false }, { ...verification(), healthPassed: false }, { ...verification(), coverage: { ...coverage(), status: 'partial' as const } }]) assert.throws(() => verifiedOccurrence(finding(), occurrence(), modified, [proof]), /INSUFFICIENT/);
});
test('source verification leaves deployed artifact exposure outstanding', () => {
  const result = verifiedOccurrence({ ...finding(), kind: 'code' }, { ...occurrence(), branch: 'main', sourceState: 'open' }, { ...verification(), dimension: 'source', revision: commit, branch: 'main' }, [{ ...evidence(), content: { sourceRevision: commit, sourceBranch: 'main', sourceRepositoryId: 'fixture-node', sourceApplicationId: 'fixture-node', findingIdentity: hash, securityCheckPassed: true } }]);
  assert.equal(result.sourceState, 'verified-fixed'); assert.equal(result.runtimeState, 'affected');
});
test('removing a secret from source does not prove invalidation', () => {
  assert.throws(() => verifiedOccurrence({ ...finding(), kind: 'credential-exposure' }, occurrence(), { ...verification(), dimension: 'source', revision: commit }, [evidence()]), /INVALIDATION/);
  const proof = { ...evidence(), source: 'credential-owner', content: { credentialInvalidated: true, consumerMigrationVerified: true, findingIdentity: hash } };
  const result = verifiedOccurrence({ ...finding(), kind: 'credential-exposure' }, occurrence(), { ...verification(), dimension: 'credential-invalidation', consumerMigrationVerified: true }, [proof]); assert.equal(result.runtimeState, 'verified-resolved');
});
test('endpoint verification refuses insecure remote URLs and credential-bearing URLs', () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/?token=value']) assert.throws(() => endpoint(url));
});
test('secret values are removed from text and structured evidence', () => {
  const synthetic = 'ghp_' + 'X'.repeat(40);
  assert.equal(redact(synthetic), '[REDACTED CREDENTIAL]');
  assert.ok(!JSON.stringify(redactObject({ token: synthetic })).includes(synthetic));
  assert.ok(!JSON.stringify(redactObject({ password: 'fixture-private-value' })).includes('fixture-private-value'));
});

test('host closure requires effective running state without inventing an image digest', () => {
  const checked = { ...verification(), artifactDigest: null };
  assert.throws(() => verifiedOccurrence(finding(), occurrence(), checked, [evidence()]), /EFFECTIVE_HOST_STATE/);
  const proof = { ...evidence(), content: { findingIdentity: hash, securityCheckPassed: true, runningStateVerified: true } };
  assert.equal(verifiedOccurrence(finding(), occurrence(), checked, [proof]).runtimeState, 'verified-resolved');
  assert.throws(() => verifiedOccurrence(finding(), occurrence(), checked, [{ ...proof, source: 'ai-scanner' }]), /INDEPENDENT_EVIDENCE/);
});
test('an unrelated source revision cannot close a finding', () => {
  const original = { ...occurrence(), branch: 'main', sourceState: 'open' as const };
  const proof = { ...evidence(), content: { sourceRevision: commit, sourceBranch: 'main', sourceRepositoryId: 'fixture-node', sourceApplicationId: 'fixture-node', findingIdentity: hash, securityCheckPassed: true } };
  assert.throws(() => verifiedOccurrence(finding(), original, { ...verification(), dimension: 'source', revision: 'b'.repeat(40), branch: 'main' }, [proof]), /IMMUTABLE_SOURCE_PROOF/);
  assert.throws(() => verifiedOccurrence(finding(), original, { ...verification(), dimension: 'source', revision: commit, branch: 'release' }, [proof]), /SOURCE_BRANCH_OR_COMPONENT/);
});
test('standing policy cannot trust a coordinator-supplied environment or understated impact', () => {
  const node = target(); assert.equal(node.kind, 'target'); if (node.kind !== 'target') return;
  assert.equal(policyCovers(policy(), plan(), [{ ...node, environment: 'production' }]), false);
  assert.equal(policyCovers({ ...policy(), actionVersions: [] }, plan(), [node]), false);
  const action = plan().actions[0]; assert.ok(action);
  assert.throws(() => assertTarget(action, { ...node, environment: 'production' }), /ENVIRONMENT/);
  assert.throws(() => validateAction({ ...action, version: 'security-update.v1', requiredCapabilities: ['embermend:security-update.v1'], parameters: { packages: [{ name: 'openssl', version: '1.0' }], previewDigest: hash, allowDependencyChanges: false, allowServiceRestarts: true } }), /IMPACT_UNDERSTATED/);
});

test('opaque credentials in quoted source, authorization headers and prefixed keys are redacted', () => {
  const value = 'fixture-opaque-credential';
  for (const text of ['Authorization: Bearer ' + value, '{"client_secret": "' + value + '"}', "const password = '" + value + "'"]) assert.ok(!redact(text).includes(value));
  const content = redactObject({ clientSecret: value, DATABASE_PASSWORD: value, refresh_token: value, authorizationRef: 'retained-reference', passwordAuthentication: false });
  assert.ok(!JSON.stringify(content).includes(value)); assert.equal(content['authorizationRef'], 'retained-reference'); assert.equal(content['passwordAuthentication'], false);
});
