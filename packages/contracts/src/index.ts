import { z } from 'zod';

export const VERSION = '0.3.0';
export const PROTOCOL = 1;
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') { const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error('JSON value required'); return encoded; }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = z.record(z.string(), z.unknown()).parse(value);
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
export const id = z.string().min(1).max(200);
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
export const timestamp = z.iso.datetime({ offset: true });
export const jsonObject = z.record(z.string(), z.json());
export const scopeSchema = z.object({ installationId: id, applicationIds: z.array(id).max(1000), targetIds: z.array(id).max(1000) }).strict();
export type Scope = z.infer<typeof scopeSchema>;
export const permissions = ['read', 'evidence', 'evidence-restricted', 'assess', 'prepare', 'propose', 'publish-explanation', 'execute', 'approve', 'policy', 'repository-write', 'merge', 'artifact-publish', 'deploy', 'exception', 'recover', 'ingest', 'audit:read'] as const;
export type Permission = (typeof permissions)[number];
export interface Actor { id: string; kind: 'operator' | 'coordinator' | 'integration'; permissions: ReadonlySet<Permission>; scope: Scope }
export const coverageSchema = z.object({
  status: z.enum(['complete', 'partial', 'unsupported', 'stale', 'failed', 'canceled']),
  requested: z.array(id), examined: z.array(id), excluded: z.array(z.object({ path: id, reason: id }).strict()),
  failures: z.array(id), mode: z.enum(['full', 'incremental']), observedAt: timestamp,
}).strict();
export type Coverage = z.infer<typeof coverageSchema>;
export const provenanceSchema = z.object({ source: id, assurance: z.enum(['established', 'inferred', 'unknown']), evidenceIds: z.array(id), observedAt: timestamp }).strict();
const entityBase = { id, scope: scopeSchema, label: id, provenance: provenanceSchema };
export const managementAgentSchema = z.object({ ...entityBase, kind: z.literal('management-agent'), magnusInstallationId: id, magnusAgentId: id, targetIds: z.array(id), capabilities: z.array(id), version: id.nullable(), lifecycle: z.enum(['active', 'offline', 'retired', 'unknown']) }).strict();
export const entitySchema = z.discriminatedUnion('kind', [
  managementAgentSchema,
  z.object({ ...entityBase, kind: z.literal('application'), owner: id.nullable(), importance: z.enum(['critical', 'high', 'normal', 'low']), deploymentExpectation: z.enum(['source-only', 'deployed', 'unknown']), environments: z.array(id) }).strict(),
  z.object({ ...entityBase, kind: z.literal('repository'), provider: z.literal('github'), providerInstance: z.url(), providerId: id, owner: id, name: id, environment: id.optional(), accessRevision: z.number().int().positive() }).strict(),
  z.object({ ...entityBase, kind: z.literal('source-binding'), repositoryId: id, applicationId: id, includedPaths: z.array(id), excludedPaths: z.array(id), maintainedBranches: z.array(id), buildDefinitions: z.array(id), modelPolicy: z.object({ providerRefs: z.array(id), allowRemote: z.boolean(), allowExecution: z.boolean() }).strict().default({ providerRefs: [], allowRemote: false, allowExecution: false }) }).strict(),
  z.object({ ...entityBase, kind: z.literal('source-revision'), repositoryId: id, commit: revision, branch: id.nullable() }).strict(),
  z.object({ ...entityBase, kind: z.literal('artifact'), digest: sha256, sourceRevisionIds: z.array(id), buildRunId: id.nullable(), image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/).nullable() }).strict(),
  z.object({ ...entityBase, kind: z.literal('deployment'), applicationId: id, magnusResourceId: id.optional(), environment: id, artifactIds: z.array(id), targetIds: z.array(id), configurationDigest: sha256.nullable() }).strict(),
  z.object({ ...entityBase, kind: z.literal('target'), magnusInstallationId: id, magnusTargetId: id, agentId: id, environment: id.optional(), targetKind: z.enum(['host', 'container', 'worker']), enrollment: z.enum(['discovered', 'legacy', 'draining', 'enrolled']), platform: id, capabilities: z.array(id), lastSeenAt: timestamp, parentHostId: id.nullable(), workloadId: id.nullable(), instanceId: id.nullable(), executionNamespace: id, lifecycle: z.enum(['active', 'offline', 'retired']) }).strict(),
  z.object({ ...entityBase, kind: z.literal('container-instance'), runtimeId: id, deploymentId: id, artifactId: id, hostId: id, agentId: id.nullable(), startedAt: timestamp }).strict(),
]);
export type Entity = z.infer<typeof entitySchema>;
export const observationSchema = z.object({ id, scope: scopeSchema, source: id, sourceEventId: id, subjectId: id, type: id, observedAt: timestamp, evidenceIds: z.array(id), data: jsonObject }).strict();
export const threatSignalsSchema = z.object({ cve: z.string().regex(/^CVE-\d{4}-\d{4,}$/), kev: z.object({ listed: z.boolean(), catalogVersion: id, publishedAt: timestamp, addedOn: z.iso.date().nullable(), stale: z.boolean() }).nullable(), epss: z.object({ score: z.number().min(0).max(1), percentile: z.number().min(0).max(1), date: z.iso.date(), stale: z.boolean(), meaning: z.literal('CVE exploitation forecast; not an asset compromise probability') }).nullable(), failures: z.array(id) }).strict();
export type ThreatSignals = z.infer<typeof threatSignalsSchema>;
export const vulnerabilitySchema = z.object({ advisoryId: id, cves: z.array(id), packageName: id, installedVersion: id, fixedVersions: z.array(id), vendor: id, feedDigest: sha256, feedGeneratedAt: timestamp, engineVersion: id, vendorDecision: z.enum(['affected', 'not-affected', 'unknown']), signals: z.array(threatSignalsSchema) }).strict();
export const vulnerabilityAssessmentSchema = z.object({ id, scope: scopeSchema, targetId: id, kind: z.enum(['ubuntu', 'image']), imageRef: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/).nullable(), deadline: timestamp }).strict().superRefine((value, context) => { if ((value.kind === 'image') !== (value.imageRef !== null)) context.addIssue({ code: 'custom', message: 'Image assessment requires an immutable image; host assessment must not supply one' }); });
export const riskSchema = z.object({ exposure: z.enum(['internet', 'internal', 'isolated', 'unknown']), importance: z.enum(['critical', 'high', 'normal', 'low', 'unknown']), firstSeenAt: timestamp, fixAvailability: z.enum(['available', 'unavailable', 'unknown']), factors: z.array(z.object({ reason: id, points: z.number() }).strict()), evidenceIds: z.array(id) }).strict();
export const findingSchema = z.object({
  id, scope: scopeSchema, kind: z.enum(['hardening', 'os-package', 'dependency', 'image', 'code', 'credential-exposure']),
  identity: sha256, component: id, weakness: id, title: z.string().min(1).max(1000), severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']),
  confidence: z.number().min(0).max(1), validity: z.enum(['candidate', 'validated', 'disputed', 'false-positive']),
  risk: riskSchema.optional(), vulnerability: vulnerabilitySchema.optional(),
  rationale: z.string().max(10000), evidenceIds: z.array(id), classifications: z.array(id), priority: z.number().min(0).max(100),
}).strict();
export type Finding = z.infer<typeof findingSchema>;
export const occurrenceSchema = z.object({
  id, findingId: id, subjectId: id, branch: id.nullable(), revision: revision.nullable(), artifactDigest: sha256.nullable(),
  sourceState: z.enum(['open', 'proposed', 'verified-fixed', 'not-applicable']),
  runtimeState: z.enum(['affected', 'awaiting-deployment', 'awaiting-verification', 'verified-mitigated', 'verified-resolved', 'unknown', 'not-applicable']),
  coverage: coverageSchema, evidenceIds: z.array(id), recurrenceOf: id.nullable(),
}).strict();
export type Occurrence = z.infer<typeof occurrenceSchema>;
export const evidenceSchema = z.object({ id, scope: scopeSchema, subjectId: id, method: id, observedAt: timestamp, digest: sha256, content: jsonObject, sensitivity: z.enum(['ordinary', 'restricted']), source: id }).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export const actionClassSchema = z.enum(['assess', 'prepare', 'repository-write', 'host-change', 'merge', 'build', 'artifact-publish', 'deploy', 'restart', 'reboot', 'exception', 'recovery']);
export type ActionClass = z.infer<typeof actionClassSchema>;
export const actionSchema = z.object({
  id, version: id, class: actionClassSchema, targetId: id, targetKind: z.enum(['host', 'container', 'worker', 'repository']),
  requiredCapabilities: z.array(id).min(1), parameters: jsonObject, preconditions: jsonObject,
  dependsOn: z.array(id), verificationIds: z.array(id).min(1), recovery: z.string().min(1).max(4000),
  expectedRevision: revision.nullable(), patchDigest: sha256.nullable(), disruption: z.enum(['none', 'restart', 'reboot', 'outage']),
}).strict();
export type Action = z.infer<typeof actionSchema>;
export const planSchema = z.object({
  id, revision: z.number().int().positive(), scope: scopeSchema, campaignId: id, objective: z.string().min(1).max(4000), findingIds: z.array(id).min(1),
  evidenceIds: z.array(id).min(1), actions: z.array(actionSchema).min(1).max(100), explanation: z.string().min(1).max(20000),
  impact: z.string().min(1).max(4000), uncertainty: z.array(id), notBefore: timestamp, expiresAt: timestamp,
  stopConditions: z.array(id).min(1), maxUnavailable: z.number().int().min(1).max(100), canaryTargetId: id,
}).strict().superRefine((plan, ctx) => {
  if (new Date(plan.expiresAt) <= new Date(plan.notBefore)) ctx.addIssue({ code: 'custom', message: 'Execution window is empty' });
  const actions = new Map(plan.actions.map(action => [action.id, action]));
  if (actions.size !== plan.actions.length) ctx.addIssue({ code: 'custom', message: 'Duplicate action identity' });
  const done = new Set<string>(); const visiting = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) { ctx.addIssue({ code: 'custom', message: 'Cyclic action dependencies' }); return; }
    if (done.has(key)) return;
    const action = actions.get(key);
    if (!action) { ctx.addIssue({ code: 'custom', message: 'Unknown action dependency' }); return; }
    visiting.add(key); action.dependsOn.forEach(visit); visiting.delete(key); done.add(key);
  };
  actions.forEach(action => visit(action.id));
  if (!plan.actions.some(action => action.targetId === plan.canaryTargetId)) ctx.addIssue({ code: 'custom', message: 'Canary must belong to the plan' });
  for (const action of plan.actions) if (action.targetKind !== 'repository' && !plan.scope.targetIds.includes(action.targetId))
    ctx.addIssue({ code: 'custom', message: 'Action target outside plan scope' });
});
export type Plan = z.infer<typeof planSchema>;
export const policySchema = z.object({
  id, revision: z.number().int().positive(), scope: scopeSchema, enabled: z.boolean(), actionVersions: z.array(id).optional(), actionClasses: z.array(actionClassSchema),
  branches: z.array(id), environments: z.array(id), disruptions: z.array(z.enum(['none', 'restart', 'reboot', 'outage'])),
  notBefore: timestamp, expiresAt: timestamp, maxTargets: z.number().int().min(1).max(1000), requireVerifiedRecovery: z.boolean(),
}).strict();
export type Policy = z.infer<typeof policySchema>;
export const decisionSchema = z.object({ planId: id, revision: z.number().int().positive(), digest: sha256, decision: z.enum(['approve', 'reject']), expiresAt: timestamp }).strict();
export const verificationSchema = z.object({
  id, occurrenceId: id, dimension: z.enum(['source', 'runtime', 'mitigation', 'credential-invalidation']),
  result: z.enum(['pass', 'fail', 'unknown']), method: id, evidenceIds: z.array(id).min(1), coverage: coverageSchema,
  revision: revision.nullable(), branch: id.nullable().optional(), artifactDigest: sha256.nullable(), targetId: id, healthPassed: z.boolean(),
  observedAt: timestamp, independent: z.boolean(), consumerMigrationVerified: z.boolean(),
}).strict();
export type Verification = z.infer<typeof verificationSchema>;
export const exceptionSchema = z.object({ id, scope: scopeSchema, findingIds: z.array(id).min(1), owner: id, rationale: z.string().min(1).max(4000), compensatingControls: z.array(id), expiresAt: timestamp, status: z.enum(['active', 'expired', 'withdrawn', 'superseded']) }).strict();
export const scanRequestSchema = z.object({
  repositoryId: id, providerId: id, commit: revision, applicationId: id, scope: scopeSchema, branch: id.nullable(), pullRequest: z.number().int().positive().nullable(),
  includedPaths: z.array(id).min(1), excludedPaths: z.array(id), profile: z.literal('typescript-security.v1'), mode: z.enum(['full', 'incremental']),
  workerTargetId: id, operationId: id, deadline: timestamp, cancellationId: id,
  maxFiles: z.number().int().positive().max(10000), maxBytes: z.number().int().positive().max(10000000),
  sourcePolicy: z.object({ providerRef: id, allowRemoteModel: z.boolean(), allowRepositoryExecution: z.boolean() }).strict(),
}).strict();
export type ScanRequest = z.infer<typeof scanRequestSchema>;
export const scanCandidateSchema = z.object({
  fingerprint: sha256, component: id, path: id, line: z.number().int().positive(), symbol: id,
  weakness: z.enum(['injection', 'path-handling', 'authorization', 'trust-boundary', 'secret', 'configuration']),
  title: z.string().min(1).max(1000), evidence: z.string().min(1).max(6000), assumptions: z.array(id),
  severity: findingSchema.shape.severity, confidence: z.number().min(0).max(1), validation: findingSchema.shape.validity,
}).strict();
export type ScanCandidate = z.infer<typeof scanCandidateSchema>;
export const scanResultSchema = z.object({
  scannerVersion: id, profile: id, modelRef: id, commit: revision, operationId: id, coverage: coverageSchema,
  candidates: z.array(scanCandidateSchema).max(1000), languages: z.array(id), assessedClasses: z.array(id),
  state: z.enum(['completed', 'partial', 'failed', 'canceled']),
}).strict();
export type ScanResult = z.infer<typeof scanResultSchema>;
export const operationRequestSchema = z.object({
  operationId: id, planId: id, planRevision: z.number().int().positive(), planDigest: sha256, action: actionSchema,
  installationId: id, authorizationRef: id, expiresAt: timestamp,
}).strict();
export type OperationRequest = z.infer<typeof operationRequestSchema>;
export const receiptSchema = z.object({
  operationId: id, requestDigest: sha256, targetId: id, state: z.enum(['not-dispatched', 'queued', 'running', 'completed', 'failed', 'unknown', 'reconciled']),
  evidenceIds: z.array(id), result: jsonObject, ownershipReleased: z.boolean(), observedAt: timestamp,
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;
export const capabilitySchema = z.object({ protocol: z.literal(1), installationId: id, serviceVersion: id, actions: z.array(id), targets: z.array(entitySchema), agents: z.array(managementAgentSchema).optional(), observedAt: timestamp }).strict();
export const profileSchema = z.object({ id, version: id, platform: id, description: z.string().max(4000).optional(), coverage: z.array(id).optional(), rules: z.array(z.object({ id, explanation: id, capability: id, field: id, expected: z.json(), actionVersion: id.nullable(), appliesWhen: z.object({ field: id, equals: z.json() }).strict().optional(), impact: z.string().max(4000).optional() }).strict()).min(1) }).strict();
export type Profile = z.infer<typeof profileSchema>;
export const assessmentRequestSchema = z.object({ id, scope: scopeSchema, targetIds: z.array(id).min(1), profileId: id, profileVersion: id, deadline: timestamp }).strict();
export const jobSchema = z.object({ id, kind: id, status: z.enum(['queued', 'running', 'completed', 'failed', 'unknown', 'canceled']), progress: z.number().min(0).max(1), cancelRequested: z.boolean(), deadline: timestamp, error: z.string().nullable(), result: z.json().nullable() }).strict();
export const buildObservationRequestSchema = z.object({
  id, scope: scopeSchema, repositoryId: id, applicationId: id, sourceRevisionId: id,
  providerRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), runAttempt: z.number().int().positive(),
  workflowId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/),
  deadline: timestamp,
}).strict();
export type BuildObservationRequest = z.infer<typeof buildObservationRequestSchema>;
export const buildSchema = z.object({
  id, scope: scopeSchema, repositoryId: id, applicationId: id, sourceRevisionId: id, sourceCommit: revision,
  providerRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), runAttempt: z.number().int().positive(), workflowId: z.number().int().positive(), workflowPath: id,
  status: z.enum(['requested', 'pending', 'queued', 'waiting', 'in_progress', 'completed']),
  conclusion: z.enum(['success', 'failure', 'action_required', 'cancelled', 'neutral', 'skipped', 'stale', 'startup_failure', 'timed_out']).nullable(),
  providerUpdatedAt: timestamp, observedAt: timestamp, providerUrl: z.url(), evidenceIds: z.array(id).min(1),
  artifactProvenance: z.literal('unestablished'),
}).strict();
export type Build = z.infer<typeof buildSchema>;
export const recommendationSchema = z.object({
  plan: planSchema, digest: sha256, status: id,
  jobs: z.array(jobSchema).default([]),
  publications: z.array(z.object({ id, planId: id, revision: z.number().int().positive(), digest: sha256, surface: id, explanation: z.string(), publishedAt: timestamp })),
  executions: z.array(z.object({ id, state: id, actionId: id, targetId: id, receipt: receiptSchema.nullable() })),
  campaign: z.object({ id, installationId: id, paused: z.boolean(), generation: z.number().int(), createdAt: timestamp }).nullable(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;
export const campaignReportSchema = z.object({ reportId: id, generatedAt: timestamp, campaign: recommendationSchema.shape.campaign.unwrap(), plans: z.array(z.object({ plan: planSchema, digest: sha256, status: id, publications: recommendationSchema.shape.publications, executions: z.array(z.object({ id, revision: z.number().int(), actionId: id, state: id, receipt: receiptSchema.nullable() })), findings: z.array(z.object({ finding: findingSchema, occurrences: z.array(occurrenceSchema), verifications: z.array(verificationSchema) })) })), exceptions: z.array(exceptionSchema) });
export type CampaignReport = z.infer<typeof campaignReportSchema>;
export const accessSchema = z.object({ actorId: id, kind: z.enum(['operator', 'coordinator', 'integration']), permissions: z.array(z.enum(permissions)), scope: scopeSchema }).strict();
export const sourceEditSchema = z.object({ path: id, beforeDigest: sha256.nullable(), content: z.string().max(1000000).nullable() }).strict();
export const preparationSchema = z.object({
  id, scope: scopeSchema, repositoryId: id, applicationId: id, providerId: id, baseCommit: revision, branch: id,
  workerTargetId: id, includedPaths: z.array(id).min(1), excludedPaths: z.array(id), edits: z.array(sourceEditSchema).min(1).max(100),
  validationProfileId: id, deadline: timestamp,
}).strict();
export type Preparation = z.infer<typeof preparationSchema>;
export const preparationResultSchema = z.object({
  preparationId: id, baseCommit: revision, patchDigest: sha256, validated: z.boolean(), validationEvidence: jsonObject,
  edits: z.array(sourceEditSchema), coverage: coverageSchema,
}).strict();
export type PreparationResult = z.infer<typeof preparationResultSchema>;
export const sourceRequestSchema = z.object({ id, scope: scopeSchema, repositoryId: id, applicationId: id, providerId: id, commit: revision, workerTargetId: id, paths: z.array(id).min(1).max(30), deadline: timestamp }).strict();
export type SourceRequest = z.infer<typeof sourceRequestSchema>;
export const sourceResultSchema = z.object({ repositoryId: id, commit: revision, files: z.array(z.object({ path: id, content: z.string().max(1000000), sourceDigest: sha256, redacted: z.boolean() }).strict()), coverage: coverageSchema }).strict();
export const relationshipSchema = z.object({ id, scope: scopeSchema, fromId: id, toId: id, kind: z.enum(['owns-source', 'built-from', 'deployed-as', 'runs-on', 'managed-by', 'replaces']), provenance: provenanceSchema }).strict();
export const profileAssignmentSchema = z.object({ id, scope: scopeSchema, profileId: id, profileVersion: id, targetIds: z.array(id).min(1), impact: z.string().min(1).max(4000), supersedes: id.nullable() }).strict();
export const scheduleSchema = z.object({ id, scope: scopeSchema, kind: z.enum(['assessment', 'vulnerabilities', 'scan']), payload: z.unknown(), intervalSeconds: z.number().int().min(300).max(2592000), nextAt: timestamp, enabled: z.boolean() }).strict();
export const compatibilitySchema = z.object({ product: z.literal('embermend'), version: id, protocol: z.literal(1), magnusRequired: z.literal(true), operatorSurface: z.literal('hivexui'), runtime: id, storage: z.literal('postgresql'), supportedTargets: z.array(id) }).strict();
export const readinessSchema = z.object({ status: z.enum(['ready', 'degraded']), serviceAvailable: z.literal(true), assessmentReady: z.boolean(), managedDispatch: z.boolean(), eligibleTargets: z.number().int().min(0), blockers: z.array(id), capabilities: capabilitySchema.nullable() }).strict();

/** Version-one scanner stdio reply. Failure is explicit and carries no provider data. */
export const scannerBrokerReplySchema = z.union([
  z.object({ id: z.string().min(1).max(200), result: z.unknown() }).strict(),
  z.object({ id: z.string().min(1).max(200), error: z.literal('MODEL_BROKER_UNAVAILABLE') }).strict(),
]);

/**
 * HiveEvent v1 as served by GET /api/v1/hive/events. It mirrors the Hive:Magnus shared
 * contract in @hivemagnus/hive-common; the server validates every event with that package.
 */
export const HIVE_EVENTS_PATH = '/api/v1/hive/events';
export const hiveEventSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), product: z.literal('embermend'),
  type: z.enum(['recommendation.created', 'recommendation.approved', 'recommendation.rejected', 'recommendation.policy-authorized', 'campaign.paused', 'campaign.resumed', 'campaign.verification-stopped', 'execution.failed', 'execution.needs-attention']),
  severity: z.enum(['info', 'warning', 'critical']), title: z.string().min(1).max(200), summary: z.string().max(2000), occurredAt: z.iso.datetime(),
  subject: z.object({ nodeId: z.string().regex(/^[a-z0-9_-]{2,32}$/).optional() }).strict().optional(),
  link: z.object({ product: z.literal('embermend'), path: z.string().min(1).max(1024).regex(/^\/(?![/\\])\S*$/) }).strict(), sourceRef: z.string().min(1).max(256).optional(),
}).strict();
export type HiveEventRecord = z.infer<typeof hiveEventSchema>;
export const hiveEventPageSchema = z.object({ data: z.array(hiveEventSchema), nextCursor: z.string().nullable() }).strict();

/**
 * HiveAuditRecord v1 as served by GET /api/v1/audit/export: the suite-wide audit export shape
 * that Cindertrace pulls from each product. Every product defines this schema unchanged.
 */
export const AUDIT_EXPORT_PATH = '/api/v1/audit/export';
export const AUDIT_READ_PERMISSION = 'embermend:audit:read';
const auditScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const hiveAuditRecordSchema = z.object({
  id: z.string().regex(/^(hivemem|hiveskills|ardentstudio|embermend):audit:[A-Za-z0-9._:-]{1,200}$/),
  product: z.enum(['hivemem', 'hiveskills', 'ardentstudio', 'embermend']),
  occurredAt: z.iso.datetime(),
  action: z.string().min(1).max(128).regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/),
  outcome: z.enum(['success', 'failure']),
  actor: z.object({ type: z.enum(['user', 'service', 'agent', 'system']), id: z.string().min(1).max(256), issuer: z.string().min(1).max(256).optional(), displayName: z.string().min(1).max(256).optional() }).strict(),
  target: z.object({ type: z.string().min(1).max(128).optional(), id: z.string().min(1).max(256).optional() }).strict().optional(),
  subject: z.object({ actorId: z.string().min(1).max(256).optional(), agentRef: z.string().min(1).max(256).optional(), nodeId: z.string().min(1).max(256).optional() }).strict().optional(),
  details: z.record(z.string(), auditScalar).refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 4096, 'Audit details exceed 4 KB'),
}).strict();
export type HiveAuditRecord = z.infer<typeof hiveAuditRecordSchema>;
export const hiveAuditPageSchema = z.object({ data: z.array(hiveAuditRecordSchema), nextCursor: z.string().nullable() }).strict();
