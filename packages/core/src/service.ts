import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { entitySchema, evidenceSchema, findingSchema, occurrenceSchema, planSchema, policySchema, decisionSchema, verificationSchema, exceptionSchema, receiptSchema, profileSchema, assessmentRequestSchema, vulnerabilityAssessmentSchema, scanRequestSchema, sourceRequestSchema, preparationSchema, preparationResultSchema, scopeSchema, type Actor, type Entity, type Plan, type Action, type OperationRequest, type Receipt } from '@hivemagnus/embermend-contracts';
import { audit, digest, enqueue, json, lock, within, Prisma, type Database, type Transaction } from '@hivemagnus/embermend-store';
import { redactObject, redact, IntegrationError, githubMergeOperationSchema, type GitHubMergeOperation, type Magnus, type GitHubClient } from '@hivemagnus/embermend-integrations';
import { matchesPath, safePath } from '@hivemagnus/embermend-scanner';
import { DomainError, requirePermission, requireActionPermission, validateAction, policyCovers, assertTarget } from './authorization.js';
import { prioritize } from './priority.js';
import { verifiedOccurrence } from './verification.js';

import { admitDeployment } from './deployment.js';
import { Records } from './records.js';
import { Builds } from './builds.js';
const remediationBranch = (preparationId: string): string => `embermend/${preparationId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100)}`;

export class Embermend {
  public readonly records: Records;
  public readonly builds: Builds;
  constructor(public readonly db: Database, public readonly magnus: Magnus, public readonly github?: GitHubClient) { this.records = new Records(db); this.builds = new Builds(db, github); }
  async entity(actor: Actor, input: unknown): Promise<Entity> {
    const value = entitySchema.parse(input);
    if (Date.parse(value.provenance.observedAt) > Date.now() + 120000) throw new DomainError('FUTURE_INVENTORY_PROVENANCE');
    requirePermission(actor, 'ingest', value.scope);
    if (value.kind === 'source-binding' || value.kind === 'application') requirePermission(actor, 'policy', value.scope);
    const stableKey = value.kind === 'repository' ? `repository:${value.providerInstance}:${value.providerId}` : value.kind === 'management-agent' ? `agent:${value.magnusInstallationId}:${value.magnusAgentId}` : value.kind === 'target' ? `target:${value.magnusInstallationId}:${value.magnusTargetId}` : value.kind === 'artifact' ? `artifact:${value.scope.installationId}:${value.digest}` : `${value.kind}:${value.scope.installationId}:${value.id}`;
    return this.db.$transaction(async tx => {
      await lock(tx, stableKey);
      const current = await tx.entity.findUnique({ where: { stableKey } });
      if (current) requirePermission(actor, 'ingest', entitySchema.parse(current.data).scope);
      if (value.kind === 'repository') {
        const previous = current ? entitySchema.parse(current.data) : null;
        if (!previous || previous.kind !== 'repository' || previous.owner !== value.owner || previous.accessRevision !== value.accessRevision || previous.environment !== value.environment) requirePermission(actor, 'policy', value.scope);
      }
      if (current && ['artifact', 'source-revision'].includes(value.kind)) {
        const previous = entitySchema.parse(current.data);
        const immutable = (entity: Entity): string => digest(Object.fromEntries(Object.entries(entity).filter(([key]) => !['label', 'provenance'].includes(key))));
        if (immutable({ ...value, id: current.id }) !== immutable(previous)) throw new DomainError('IMMUTABLE_ARTIFACT_OR_SOURCE_IDENTITY');
      }
      const stored = current ? { ...value, id: current.id } : value;
      await tx.entity.upsert({ where: { stableKey }, create: { id: stored.id, kind: stored.kind, stableKey, installationId: stored.scope.installationId, data: json(stored) }, update: { data: json(stored), version: { increment: 1 } } });
      const eventId = digest(stored);
      const historyId = digest([stored.scope.installationId, 'inventory', stored.id, eventId]);
      if (!await tx.observation.findUnique({ where: { id: historyId } })) await tx.observation.create({ data: { id: historyId, installationId: stored.scope.installationId, subjectId: stored.id, source: 'entity-reconciliation', sourceEventId: eventId, observedAt: new Date(stored.provenance.observedAt), data: json({ id: historyId, scope: stored.scope, subjectId: stored.id, source: 'entity-reconciliation', sourceEventId: eventId, type: 'inventory', observedAt: stored.provenance.observedAt, evidenceIds: stored.provenance.evidenceIds, data: { entity: stored } }) } });
      await audit(tx, actor, 'entity.reconciled', stored.id, { observationId: historyId, digest: eventId }); return stored;
    });
  }
  async entities(actor: Actor): Promise<Entity[]> {
    requirePermission(actor, 'read', actor.scope);
    return (await this.db.entity.findMany({ where: { installationId: actor.scope.installationId }, orderBy: { id: 'asc' }, take: 1000 })).map(row => entitySchema.parse(row.data)).filter(entity => within(actor.scope, entity.scope));
  }
  async evidence(actor: Actor, input: unknown): Promise<string> {
    const value = evidenceSchema.parse(input); requirePermission(actor, 'ingest', value.scope);
    if (Date.parse(value.observedAt) > Date.now() + 120000) throw new DomainError('FUTURE_EVIDENCE');
    const sanitized = { ...value, content: redactObject(value.content) }; sanitized.digest = digest(sanitized.content);
    await this.db.$transaction(async tx => {
      const existing = await tx.evidence.findUnique({ where: { id: value.id } });
      if (existing && digest(existing.data) !== digest(sanitized)) throw new DomainError('IMMUTABLE_EVIDENCE_CONFLICT');
      if (!existing) await tx.evidence.create({ data: { id: value.id, installationId: value.scope.installationId, subjectId: value.subjectId, digest: sanitized.digest, data: json(sanitized) } });
      await audit(tx, actor, 'evidence.ingested', value.id);
    }); return value.id;
  }
  async readEvidence(actor: Actor, id: string) {
    const row = await this.db.evidence.findUnique({ where: { id } }); if (!row) throw new DomainError('NOT_FOUND', 404);
    const value = evidenceSchema.parse(row.data); requirePermission(actor, 'evidence', value.scope); if (value.sensitivity === 'restricted') requirePermission(actor, 'evidence-restricted', value.scope); return value;
  }
  async finding(actor: Actor, input: unknown, rawOccurrence: unknown): Promise<string> {
    const parsedFinding = findingSchema.parse(input); const value = { ...parsedFinding, title: redact(parsedFinding.title), rationale: redact(parsedFinding.rationale) }; const occurrence = occurrenceSchema.parse(rawOccurrence); requirePermission(actor, 'ingest', value.scope);
    if (occurrence.findingId !== value.id) throw new DomainError('FINDING_OCCURRENCE_MISMATCH');
    return this.db.$transaction(async tx => {
      await lock(tx, `finding-id:${value.id}`);
      await lock(tx, `finding:${value.scope.installationId}:${value.identity}`);
      const named = await tx.finding.findUnique({ where: { id: value.id } });
      if (named) { requirePermission(actor, 'ingest', findingSchema.parse(named.data).scope); if (named.identity !== value.identity || named.installationId !== value.scope.installationId) throw new DomainError('FINDING_IDENTITY_CONFLICT'); }
      for (const evidenceId of value.evidenceIds) {
        const evidence = await tx.evidence.findUnique({ where: { id: evidenceId } });
        if (!evidence || !within(value.scope, evidenceSchema.parse(evidence.data).scope)) throw new DomainError('FINDING_EVIDENCE_UNAVAILABLE');
      }
      const existing = await tx.finding.findUnique({ where: { installationId_identity: { installationId: value.scope.installationId, identity: value.identity } } });
      const oldFinding = existing ? findingSchema.parse(existing.data) : null;
      if (oldFinding && !within(actor.scope, oldFinding.scope)) throw new DomainError('EXISTING_FINDING_OUTSIDE_SCOPE', 403);
      if (oldFinding && (oldFinding.component !== value.component || oldFinding.kind !== value.kind || oldFinding.weakness !== value.weakness)) throw new DomainError('FINDING_MATCH_REQUIRES_REVIEW');
      const id = existing?.id ?? value.id;
      const delivered = await tx.occurrence.findUnique({ where: { id: occurrence.id } });
      const previousDelivery = delivered ? occurrenceSchema.parse(delivered.data) : null;
      if (delivered && (delivered.findingId !== id || digest([previousDelivery?.subjectId, previousDelivery?.branch, previousDelivery?.revision, previousDelivery?.artifactDigest]) !== digest([occurrence.subjectId, occurrence.branch, occurrence.revision, occurrence.artifactDigest]))) throw new DomainError('OCCURRENCE_IDENTITY_CONFLICT');
      if (occurrence.sourceState === 'verified-fixed' && previousDelivery?.sourceState !== occurrence.sourceState || ['verified-resolved', 'verified-mitigated'].includes(occurrence.runtimeState) && previousDelivery?.runtimeState !== occurrence.runtimeState) throw new DomainError('VERIFICATION_OPERATION_REQUIRED');
      // Replaying an already ingested observation cannot reopen a later
      // verification. A genuinely new observation carries new evidence IDs.
      if (previousDelivery && occurrence.evidenceIds.length && occurrence.evidenceIds.every(evidenceId => previousDelivery.evidenceIds.includes(evidenceId))) return id;
      let occurrenceId = occurrence.id;
      let recurrenceOf = occurrence.recurrenceOf;
      let recurrence = false;
      const affected = occurrence.sourceState === 'open' || occurrence.runtimeState === 'affected';
      for (let generation = 0; generation < 100; generation++) {
        const old = await tx.occurrence.findUnique({ where: { id: occurrenceId } });
        if (!old) break;
        if (old.findingId !== id) throw new DomainError('OCCURRENCE_IDENTITY_CONFLICT');
        const previous = occurrenceSchema.parse(old.data);
        if (!affected || previous.sourceState !== 'verified-fixed' && previous.runtimeState !== 'verified-resolved') { recurrenceOf = previous.recurrenceOf; break; }
        recurrence = true; recurrenceOf = previous.id; occurrenceId = digest([previous.id, 'recurrence']);
        if (generation === 99) throw new DomainError('RECURRENCE_HISTORY_REQUIRES_REVIEW');
      }
      const next = { ...occurrence, id: occurrenceId, findingId: id, recurrenceOf };
      const applications = (await tx.entity.findMany({ where: { id: { in: value.scope.applicationIds }, kind: 'application', installationId: value.scope.installationId } })).map(row => entitySchema.parse(row.data));
      const importance = applications.some(app => app.kind === 'application' && app.importance === 'critical') ? 'critical' : applications.some(app => app.kind === 'application' && app.importance === 'high') ? 'high' : applications.some(app => app.kind === 'application' && app.importance === 'normal') ? 'normal' : applications.some(app => app.kind === 'application' && app.importance === 'low') ? 'low' : 'unknown';
      const selectedRisk = value.risk ?? oldFinding?.risk;
      for (const evidenceId of selectedRisk?.evidenceIds ?? []) { const row = await tx.evidence.findUnique({ where: { id: evidenceId } }); if (!row || !within(value.scope, evidenceSchema.parse(row.data).scope)) throw new DomainError('PRIORITY_EVIDENCE_SCOPE'); }
      if (selectedRisk && selectedRisk.exposure !== 'unknown' && !selectedRisk.evidenceIds.length) throw new DomainError('EXPOSURE_CLASSIFICATION_REQUIRES_EVIDENCE');
      const priority = prioritize({ ...value, ...(selectedRisk ? { risk: selectedRisk } : {}) }, oldFinding?.risk?.firstSeenAt ?? existing?.createdAt.toISOString() ?? new Date().toISOString(), importance);
      const persisted = { ...value, ...priority, id, validity: value.validity === 'candidate' && oldFinding ? oldFinding.validity : value.validity, evidenceIds: [...new Set([...(oldFinding?.evidenceIds ?? []), ...value.evidenceIds])] };
      await tx.finding.upsert({ where: { id }, create: { id, installationId: value.scope.installationId, identity: value.identity, data: json(persisted) }, update: { data: json(persisted) } });
      await tx.occurrence.upsert({ where: { id: next.id }, create: { id: next.id, findingId: id, subjectId: next.subjectId, data: json(next) }, update: { data: json(next) } });
      await audit(tx, actor, recurrence ? 'finding.recurred' : 'finding.observed', id); return id;
    });
  }
  async findings(actor: Actor) {
    requirePermission(actor, 'read', actor.scope);
    const rows = await this.db.finding.findMany({ where: { installationId: actor.scope.installationId }, orderBy: { updatedAt: 'desc' }, take: 1000 });
    const result = [];
    for (const row of rows) { const finding = findingSchema.parse(row.data); if (within(actor.scope, finding.scope)) result.push({ finding, occurrences: (await this.db.occurrence.findMany({ where: { findingId: finding.id } })).map(item => occurrenceSchema.parse(item.data)) }); }
    return result;
  }
  async propose(actor: Actor, input: unknown): Promise<{ id: string; revision: number; digest: string }> {
    const plan = planSchema.parse(input); requirePermission(actor, 'propose', plan.scope);
    if (digest(redactObject(plan)) !== digest(plan)) throw new DomainError('SENSITIVE_PLAN_CONTENT_REQUIRES_REDACTION'); plan.actions.forEach(validateAction);
    return this.db.$transaction(async tx => {
      await lock(tx, `authority:${actor.scope.installationId}`); await lock(tx, `campaign:${plan.campaignId}`); await lock(tx, `plan:${plan.id}`);
      const current = await tx.plan.findUnique({ where: { id: plan.id } });
      if (current) { const previous = await this.planIn(tx, actor, plan.id); requirePermission(actor, 'propose', previous.scope); }
      if (plan.revision !== (current?.currentRevision ?? 0) + 1 || (current && (current.installationId !== plan.scope.installationId || current.campaignId !== plan.campaignId))) throw new DomainError('PLAN_REVISION_CONFLICT');
      for (const findingId of plan.findingIds) { const row = await tx.finding.findUnique({ where: { id: findingId } }); if (!row || !within(plan.scope, findingSchema.parse(row.data).scope)) throw new DomainError('FINDING_OUTSIDE_PLAN_SCOPE'); }
      for (const evidenceId of plan.evidenceIds) { const row = await tx.evidence.findUnique({ where: { id: evidenceId } }); if (!row || !within(plan.scope, evidenceSchema.parse(row.data).scope)) throw new DomainError('EVIDENCE_OUTSIDE_PLAN_SCOPE'); }
      const campaign = await tx.campaign.findUnique({ where: { id: plan.campaignId } });
      if (campaign && campaign.installationId !== plan.scope.installationId) throw new DomainError('CAMPAIGN_SCOPE_MISMATCH');
      if (campaign) for (const member of await tx.plan.findMany({ where: { campaignId: campaign.id } })) requirePermission(actor, 'propose', (await this.planIn(tx, actor, member.id)).scope);
      if (!campaign) await tx.campaign.create({ data: { id: plan.campaignId, installationId: plan.scope.installationId } });
      await tx.plan.upsert({ where: { id: plan.id }, create: { id: plan.id, installationId: plan.scope.installationId, campaignId: plan.campaignId, currentRevision: plan.revision }, update: { currentRevision: plan.revision, status: 'draft' } });
      const hash = digest(plan);
      await tx.planRevision.create({ data: { planId: plan.id, revision: plan.revision, digest: hash, data: json(plan) } });
      await tx.authorization.updateMany({ where: { planId: plan.id }, data: { revoked: true } });
      await audit(tx, actor, 'plan.proposed', plan.id, { revision: plan.revision, digest: hash }); return { id: plan.id, revision: plan.revision, digest: hash };
    });
  }
  private async planIn(tx: Transaction, actor: Actor, id: string): Promise<Plan> {
    const plan = await tx.plan.findUnique({ where: { id } }); if (!plan) throw new DomainError('NOT_FOUND', 404);
    const row = await tx.planRevision.findUnique({ where: { planId_revision: { planId: id, revision: plan.currentRevision } } });
    if (!row) throw new DomainError('PLAN_REVISION_MISSING'); const value = planSchema.parse(row.data); requirePermission(actor, 'read', value.scope); return value;
  }
  async plan(actor: Actor, id: string): Promise<Plan> { return this.db.$transaction(tx => this.planIn(tx, actor, id)); }
  async publish(actor: Actor, id: string, revision: number): Promise<string> {
    return this.db.$transaction(async tx => {
      await lock(tx, `plan:${id}`); const plan = await this.planIn(tx, actor, id); requirePermission(actor, 'publish-explanation', plan.scope);
      if (plan.revision !== revision) throw new DomainError('STALE_PLAN_REVISION');
      // This is the primary HiveXUI timeline's authoritative read model. A committed
      // publication is visible without requiring an online browser or acknowledgement.
      const publication = await tx.publication.upsert({ where: { planId_revision_surface: { planId: id, revision, surface: 'hivexui' } }, create: { id: randomUUID(), planId: id, revision, digest: digest(plan), surface: 'hivexui', explanation: plan.explanation }, update: {} });
      await tx.plan.update({ where: { id }, data: { status: 'explained' } }); await audit(tx, actor, 'plan.explanation.published', id, { revision, publicationId: publication.id }); return publication.id;
    });
  }
  async policy(actor: Actor, input: unknown): Promise<string> {
    const policy = policySchema.parse(input); requirePermission(actor, 'policy', policy.scope);
    await this.db.$transaction(async tx => {
      await lock(tx, `authority:${actor.scope.installationId}`); await lock(tx, `policy:${policy.id}`); const existing = await tx.policy.findUnique({ where: { id: policy.id } });
      if (existing) requirePermission(actor, 'policy', policySchema.parse(existing.data).scope);
      if (policy.revision !== (existing?.revision ?? 0) + 1 || (existing && existing.installationId !== policy.scope.installationId)) throw new DomainError('POLICY_REVISION_CONFLICT');
      await tx.policy.upsert({ where: { id: policy.id }, create: { id: policy.id, installationId: policy.scope.installationId, revision: policy.revision, data: json(policy) }, update: { revision: policy.revision, data: json(policy) } });
      await tx.authorization.updateMany({ where: { policyId: policy.id }, data: { revoked: true } }); await audit(tx, actor, 'policy.revised', policy.id, { revision: policy.revision });
    }); return policy.id;
  }
  async decide(actor: Actor, input: unknown): Promise<string> {
    const decision = decisionSchema.parse(input);
    return this.db.$transaction(async tx => {
      await lock(tx, `authority:${actor.scope.installationId}`); await lock(tx, `plan:${decision.planId}`); const plan = await this.planIn(tx, actor, decision.planId); requirePermission(actor, 'approve', plan.scope);
      if (plan.revision !== decision.revision || digest(plan) !== decision.digest || Date.parse(decision.expiresAt) <= Date.now() || Date.parse(decision.expiresAt) > Date.parse(plan.expiresAt)) throw new DomainError('STALE_OR_INVALID_DECISION');
      await this.requirePublication(tx, plan);
      await tx.authorization.updateMany({ where: { planId: plan.id }, data: { revoked: true } });
      const id = randomUUID();
      if (decision.decision === 'approve') await tx.authorization.create({ data: { id, planId: plan.id, revision: plan.revision, digest: decision.digest, actorId: actor.id, kind: 'explicit', expiresAt: new Date(decision.expiresAt) } });
      await tx.plan.update({ where: { id: plan.id }, data: { status: decision.decision === 'approve' ? 'authorized' : 'rejected' } }); await audit(tx, actor, `plan.${decision.decision}`, plan.id, { decisionId: id, revision: plan.revision }); return id;
    });
  }
  private async requirePublication(tx: Transaction, plan: Plan): Promise<void> {
    const publication = await tx.publication.findUnique({ where: { planId_revision_surface: { planId: plan.id, revision: plan.revision, surface: 'hivexui' } } });
    if (!publication || publication.digest !== digest(plan)) throw new DomainError('EXPLANATION_PUBLICATION_REQUIRED');
  }
  async authorizePolicy(actor: Actor, planId: string, policyId: string): Promise<string> {
    return this.db.$transaction(async tx => {
      await lock(tx, `authority:${actor.scope.installationId}`); await lock(tx, `policy:${policyId}`); await lock(tx, `plan:${planId}`); const plan = await this.planIn(tx, actor, planId); requirePermission(actor, 'execute', plan.scope); await this.requirePublication(tx, plan);
      const row = await tx.policy.findUnique({ where: { id: policyId } }); if (!row) throw new DomainError('POLICY_NOT_FOUND');
      const policy = policySchema.parse(row.data); const targets = [];
      for (const action of plan.actions) { const row = await tx.entity.findUnique({ where: { id: action.targetId } }); if (row) targets.push(entitySchema.parse(row.data)); }
      if (!policyCovers(policy, plan, targets, new Date(), await this.recoveryEvidence(tx, plan))) throw new DomainError('STANDING_POLICY_DOES_NOT_COVER_PLAN');
      const id = randomUUID(); await tx.authorization.create({ data: { id, planId, revision: plan.revision, digest: digest(plan), actorId: actor.id, kind: 'policy', policyId, policyRevision: policy.revision, expiresAt: new Date(Math.min(Date.parse(plan.expiresAt), Date.parse(policy.expiresAt))) } });
      await tx.plan.update({ where: { id: planId }, data: { status: 'authorized' } }); await audit(tx, actor, 'plan.policy-authorized', planId, { authorizationId: id, policyId, policyRevision: policy.revision }); return id;
    });
  }
  async execute(actor: Actor, planId: string, expected: unknown): Promise<string> {
    const plan = await this.plan(actor, planId); requirePermission(actor, 'execute', plan.scope);
    const revision = z.object({ revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(expected);
    if (revision.revision !== plan.revision || revision.digest !== digest(plan)) throw new DomainError('STALE_EXECUTION_REQUEST');
    plan.actions.forEach(action => requireActionPermission(actor, action, plan.scope));
    return this.db.$transaction(tx => enqueue(tx, actor, 'campaign', `${plan.id}:${plan.revision}`, { planId: plan.id, revision: plan.revision, scope: plan.scope }, new Date(plan.expiresAt)));
  }
  async pause(actor: Actor, campaignId: string, paused: boolean): Promise<void> {
    await this.db.$transaction(async tx => {
      await lock(tx, `campaign:${campaignId}`); const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign || campaign.installationId !== actor.scope.installationId) throw new DomainError('NOT_FOUND', 404);
      const plans = await tx.plan.findMany({ where: { campaignId } });
      for (const plan of plans) requirePermission(actor, 'execute', (await this.planIn(tx, actor, plan.id)).scope);
      await tx.campaign.update({ where: { id: campaignId }, data: { paused, generation: { increment: 1 } } }); await audit(tx, actor, paused ? 'campaign.paused' : 'campaign.resumed', campaignId);
    });
  }
  async dispatch(actor: Actor, planId: string, actionId: string): Promise<Receipt> {
    const plan = await this.plan(actor, planId); requirePermission(actor, 'execute', plan.scope);
    const action = plan.actions.find(value => value.id === actionId); if (!action) throw new DomainError('ACTION_NOT_FOUND');
    requireActionPermission(actor, action, plan.scope);
    if (action.targetKind === 'repository') return this.dispatchRepository(actor, plan, action);
    const capabilities = await this.magnus.capabilities();
    const storedTarget = await this.db.entity.findUnique({ where: { id: action.targetId } });
    if (!storedTarget) throw new DomainError('TARGET_UNKNOWN'); const target = entitySchema.parse(storedTarget.data);
    if (target.kind !== 'target') throw new DomainError('PROVIDER_ACTION_REQUIRES_PROVIDER_DISPATCH');
    const currentTarget = capabilities.targets.find(item => item.kind === 'target' && item.magnusTargetId === target.magnusTargetId && item.magnusInstallationId === target.magnusInstallationId);
    if (!currentTarget || currentTarget.kind !== 'target' || capabilities.installationId !== target.magnusInstallationId || !capabilities.actions.includes(action.version)) throw new DomainError('MAGNUS_CAPABILITY_UNAVAILABLE');
    const capabilityAge = Date.now() - Date.parse(capabilities.observedAt);
    if (!Number.isFinite(capabilityAge) || Math.abs(capabilityAge) > 120000) throw new DomainError('MAGNUS_CAPABILITIES_STALE');
    // Inventory may predate the operator's review. Use Magnus's fresh liveness
    // and capabilities, while refusing a changed execution identity or scope.
    const identity = (value: Extract<Entity, { kind: 'target' }>): string => digest([value.id, value.scope, value.magnusInstallationId, value.magnusTargetId, value.agentId, value.targetKind, value.platform, value.environment ?? null, value.parentHostId, value.workloadId, value.instanceId, value.executionNamespace]);
    if (identity(target) !== identity(currentTarget)) throw new DomainError('TARGET_EXECUTION_IDENTITY_CHANGED');
    assertTarget(action, currentTarget);
    const execution = await this.db.$transaction(async tx => {
      await lock(tx, `authority:${actor.scope.installationId}`); await lock(tx, `campaign:${plan.campaignId}`); await lock(tx, `plan:${plan.id}`);
      const current = await this.planIn(tx, actor, plan.id); if (digest(current) !== digest(plan)) throw new DomainError('STALE_PLAN');
      await this.requirePublication(tx, plan);
      await admitDeployment(tx, plan, action);
      const campaign = await tx.campaign.findUnique({ where: { id: plan.campaignId } });
      if (!campaign || campaign.paused) throw new DomainError('CAMPAIGN_PAUSED');
      if (Date.parse(plan.notBefore) > Date.now() || Date.parse(plan.expiresAt) <= Date.now()) throw new DomainError('OUTSIDE_EXECUTION_WINDOW');
      const authorization = await tx.authorization.findFirst({ where: { planId: plan.id, revision: plan.revision, digest: digest(plan), revoked: false, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
      if (!authorization) throw new DomainError('CURRENT_AUTHORIZATION_REQUIRED');
      if (authorization.policyId) {
        const row = await tx.policy.findUnique({ where: { id: authorization.policyId } });
        const policy = row ? policySchema.parse(row.data) : null;
        const allTargets = (await tx.entity.findMany({ where: { id: { in: plan.actions.map(value => value.targetId) } } })).map(row => entitySchema.parse(row.data));
        if (!policy || policy.revision !== authorization.policyRevision || !policyCovers(policy, plan, allTargets, new Date(), await this.recoveryEvidence(tx, plan))) throw new DomainError('POLICY_CHANGED');
      }
      const existing = await tx.execution.findUnique({ where: { planId_revision_actionId: { planId: plan.id, revision: plan.revision, actionId } } });
      if (existing) return existing;
      for (const dependency of action.dependsOn) {
        const prior = await tx.execution.findUnique({ where: { planId_revision_actionId: { planId: plan.id, revision: plan.revision, actionId: dependency } } });
        const dependencyAction = plan.actions.find(candidate => candidate.id === dependency);
        if (!prior || !dependencyAction || prior.state !== 'completed' || !prior.receipt || !receiptSchema.parse(prior.receipt).ownershipReleased) throw new DomainError('DEPENDENCY_NOT_VERIFIED');
        await this.requireActionVerifications(tx, dependencyAction, prior.createdAt);
      }
      const unresolved = await tx.execution.count({ where: { planId: plan.id, state: { in: ['unknown', 'failed'] } } });
      if (unresolved) throw new DomainError('CAMPAIGN_STOP_CONDITION');
      if (action.targetId !== plan.canaryTargetId) {
        const canary = await tx.execution.findMany({ where: { planId: plan.id, revision: plan.revision, targetId: plan.canaryTargetId } });
        if (canary.length === 0 || canary.some(item => item.state !== 'completed')) throw new DomainError('CANARY_NOT_COMPLETED');
        for (const operation of canary) {
          const canaryAction = plan.actions.find(candidate => candidate.id === operation.actionId);
          if (!canaryAction) throw new DomainError('CANARY_ACTION_MISSING');
          await this.requireActionVerifications(tx, canaryAction, operation.createdAt);
        }
      }
      const running = await tx.execution.count({ where: { planId: plan.id, state: { in: ['queued', 'running'] } } }); if (running >= plan.maxUnavailable) throw new DomainError('DISRUPTION_LIMIT');
      const id = randomUUID();
      const request: OperationRequest = { operationId: id, planId: plan.id, planRevision: plan.revision, planDigest: digest(plan), action, installationId: target.magnusInstallationId, authorizationRef: authorization.id, expiresAt: new Date(Math.min(Date.parse(plan.expiresAt), authorization.expiresAt.getTime())).toISOString() };
      await audit(tx, actor, 'execution.reserved', id, { planId, actionId, requestDigest: digest(request) });
      return tx.execution.create({ data: { id, planId: plan.id, revision: plan.revision, actionId, targetId: action.targetId, requestDigest: digest(request), request: json(request), state: 'queued', dispatchGeneration: campaign.generation } });
    });
    if (execution.state !== 'queued') return this.reconcile(actor, execution.id);
    // Persist uncertainty BEFORE the external effect. A database failure or worker
    // crash after this point cannot make a dispatch eligible for automatic replay.
    const armed = await this.db.execution.updateMany({ where: { id: execution.id, state: 'queued' }, data: { state: 'unknown' } });
    if (!armed.count) return this.reconcile(actor, execution.id);
    return this.db.$transaction(async tx => {
      await lock(tx, `authority:${actor.scope.installationId}`); await lock(tx, `campaign:${plan.campaignId}`); await lock(tx, `plan:${plan.id}`);
      const campaign = await tx.campaign.findUnique({ where: { id: plan.campaignId } }); const current = await this.planIn(tx, actor, plan.id);
      const authorization = await tx.authorization.findFirst({ where: { id: z.object({ authorizationRef: z.string() }).parse(execution.request).authorizationRef, revoked: false, expiresAt: { gt: new Date() } } });
      if (!campaign || campaign.paused || campaign.generation !== execution.dispatchGeneration || digest(current) !== digest(plan) || !authorization) throw new DomainError('DISPATCH_REVOKED_RECONCILE_ORIGINAL');
      if (Date.parse(plan.notBefore) > Date.now() || Date.parse(plan.expiresAt) <= Date.now()) throw new DomainError('EXECUTION_WINDOW_CHANGED');
      if (authorization.policyId) {
        const row = await tx.policy.findUnique({ where: { id: authorization.policyId } });
        const policy = row ? policySchema.parse(row.data) : null;
        const targets = (await tx.entity.findMany({ where: { id: { in: plan.actions.map(item => item.targetId) } } })).map(item => entitySchema.parse(item.data));
        if (!policy || policy.revision !== authorization.policyRevision || !policyCovers(policy, plan, targets, new Date(), await this.recoveryEvidence(tx, plan))) throw new DomainError('POLICY_CHANGED_BEFORE_DISPATCH');
      }
      await admitDeployment(tx, plan, action);
      const request = z.object({ operationId: z.string() }).passthrough().parse(execution.request);
      let receipt: Receipt;
      try {
        const parsed = await import('@hivemagnus/embermend-contracts');
        receipt = await this.magnus.dispatch(parsed.operationRequestSchema.parse(request));
        this.bindReceipt(receipt, execution);
      } catch (error) {
        if (!(error instanceof IntegrationError) || error.uncertain) throw new DomainError('UNKNOWN_EXECUTION_REQUIRES_RECONCILIATION');
        // Even a refusal is not absence of a previously admitted operation.
        throw new DomainError('MAGNUS_REFUSED_RECONCILE_ORIGINAL');
      }
      await tx.execution.update({ where: { id: execution.id }, data: { state: receipt.state, receipt: json(receipt) } });
      await audit(tx, actor, 'execution.receipt', execution.id, { state: receipt.state }); return receipt;
    }, { timeout: 45000 });
  }
  private async requireActionVerifications(tx: Transaction, action: import('@hivemagnus/embermend-contracts').Action, after: Date): Promise<void> {
    for (const id of action.verificationIds) {
      const row = await tx.verification.findUnique({ where: { id } });
      if (!row) throw new DomainError('ACTION_VERIFICATION_REQUIRED');
      const verification = verificationSchema.parse(row.data);
      if (verification.targetId !== action.targetId || verification.result !== 'pass' || !verification.healthPassed || !verification.independent || verification.coverage.status !== 'complete' || Date.parse(verification.observedAt) < after.getTime()) throw new DomainError('ACTION_VERIFICATION_REQUIRED');
    }
  }
  private async recoveryEvidence(tx: Transaction, plan: Plan): Promise<Set<string>> {
    const verified = new Set<string>();
    for (const action of plan.actions) {
      const reference = action.preconditions['recoveryEvidenceId']; if (typeof reference !== 'string') continue;
      const row = await tx.evidence.findUnique({ where: { id: reference } }); if (!row) continue;
      const evidence = evidenceSchema.parse(row.data);
      if (within(plan.scope, evidence.scope) && evidence.subjectId === action.targetId && evidence.source !== 'ai-scanner' && evidence.method === 'recovery-check.v1' && Date.now() - Date.parse(evidence.observedAt) <= 900000 && evidence.content['recoveryVerified'] === true && evidence.content['actionVersion'] === action.version && evidence.content['beforeDigest'] === action.parameters['beforeDigest']) verified.add(action.id);
    }
    return verified;
  }
  private bindReceipt(receipt: Receipt, execution: { id: string; targetId: string; requestDigest: string }): void {
    if (receipt.operationId !== execution.id || receipt.targetId !== execution.targetId || receipt.requestDigest !== execution.requestDigest) throw new DomainError('EXECUTION_RECEIPT_BINDING_FAILED');
  }
  async reconcile(actor: Actor, operationId: string): Promise<Receipt> {
    const execution = await this.db.execution.findUnique({ where: { id: operationId } }); if (!execution) throw new DomainError('NOT_FOUND', 404);
    const revision = await this.db.planRevision.findUnique({ where: { planId_revision: { planId: execution.planId, revision: execution.revision } } });
    if (!revision) throw new DomainError('ORIGINAL_PLAN_REVISION_MISSING');
    const plan = planSchema.parse(revision.data); requirePermission(actor, 'read', plan.scope);
    const request = z.object({ action: z.object({ targetKind: z.string() }).passthrough() }).passthrough().parse(execution.request);
    if (request.action.targetKind === 'repository') {
      const retained = execution.receipt ? receiptSchema.parse(execution.receipt) : null;
      if (retained && ['completed', 'failed', 'not-dispatched'].includes(retained.state)) return retained;
      if (actor.permissions.has('recover')) {
        requirePermission(actor, 'recover', plan.scope);
        const released = await this.releaseUnreservedProviderOperation(actor, execution); if (released) return released;
      }
      const action = z.object({ class: z.string(), parameters: z.object({ changeId: z.string() }).passthrough() }).passthrough().parse(request.action);
      if (action.class === 'repository-write' && this.github) {
        const observed = await this.reconcileRepositoryWrite(actor, execution, action.parameters.changeId);
        if (observed) return observed;
      }
      if (action.class === 'merge' && this.github) {
        const preparation = await this.db.preparation.findUnique({ where: { id: action.parameters.changeId } });
        if (!preparation) throw new DomainError('ORIGINAL_PREPARATION_MISSING'); requirePermission(actor, 'read', preparationSchema.parse(preparation.data).scope);
        const effect = await this.db.providerEffect.findUnique({ where: { planId_revision_actionId_phase: { planId: execution.planId, revision: execution.revision, actionId: execution.actionId, phase: 'merge' } } });
        const stored = z.object({ value: githubMergeOperationSchema }).safeParse(effect?.result);
        const repo = await this.db.entity.findUnique({ where: { id: execution.targetId } }); const repository = repo ? entitySchema.parse(repo.data) : null;
        if (!repository || repository.kind !== 'repository') throw new DomainError('ORIGINAL_REPOSITORY_MISSING'); requirePermission(actor, 'read', repository.scope);
        if (stored.success) {
          if (stored.data.value.providerId !== repository.providerId || stored.data.value.headCommit !== action.parameters['headCommit']) throw new DomainError('PROVIDER_MERGE_IDENTITY_CHANGED');
          return this.recordMergeObservation(actor, execution, preparation.id, await this.github.observeMerge(repository.providerId, stored.data.value));
        }
      }
      if (retained) return retained;
      return { operationId, requestDigest: execution.requestDigest, targetId: execution.targetId, state: 'unknown', evidenceIds: [], result: { reason: 'Provider phases retain their original identities; reconcile the original provider operation before further writes' }, ownershipReleased: false, observedAt: new Date().toISOString() };
    }
    const receipt = await this.magnus.receipt(operationId); this.bindReceipt(receipt, execution);
    return this.db.$transaction(async tx => {
      await lock(tx, `execution-observation:${operationId}`);
      const current = await tx.execution.findUnique({ where: { id: operationId } });
      const prior = current?.receipt ? receiptSchema.parse(current.receipt) : null;
      if (prior && ['completed', 'failed', 'not-dispatched'].includes(prior.state) && prior.ownershipReleased) {
        if (receipt.state !== prior.state || !receipt.ownershipReleased) return prior;
        const facts = (value: Receipt): string => digest({ state: value.state, result: value.result, evidenceIds: value.evidenceIds, ownershipReleased: value.ownershipReleased });
        if (facts(receipt) !== facts(prior)) throw new DomainError('EXECUTION_TERMINAL_RECEIPT_CONFLICT');
        return prior;
      }
      await tx.execution.update({ where: { id: operationId }, data: { state: receipt.state, receipt: json(receipt) } }); await audit(tx, actor, 'execution.reconciled', operationId, { state: receipt.state, ownershipReleased: receipt.ownershipReleased }); return receipt;
    });
  }
  async verify(actor: Actor, input: unknown): Promise<string> {
    const verification = verificationSchema.parse(input);
    await this.db.$transaction(async tx => {
      await lock(tx, `authority:${actor.scope.installationId}`); await lock(tx, `occurrence:${verification.occurrenceId}`);
      const occurrenceRow = await tx.occurrence.findUnique({ where: { id: verification.occurrenceId } }); if (!occurrenceRow) throw new DomainError('NOT_FOUND', 404);
      const findingRow = await tx.finding.findUnique({ where: { id: occurrenceRow.findingId } }); if (!findingRow) throw new DomainError('NOT_FOUND', 404);
      const finding = findingSchema.parse(findingRow.data); requirePermission(actor, 'ingest', finding.scope);
      const evidence = [];
      for (const id of verification.evidenceIds) { const row = await tx.evidence.findUnique({ where: { id } }); if (!row) throw new DomainError('MISSING_VERIFICATION_EVIDENCE'); const item = evidenceSchema.parse(row.data); if (!within(finding.scope, item.scope)) throw new DomainError('VERIFICATION_EVIDENCE_SCOPE'); evidence.push(item); }
      const previous = occurrenceSchema.parse(occurrenceRow.data);
      if (verification.dimension === 'source') {
        const bindings = (await tx.entity.findMany({ where: { kind: 'source-binding', installationId: finding.scope.installationId } })).map(row => entitySchema.parse(row.data)).filter(item => item.kind === 'source-binding' && item.repositoryId === previous.subjectId && item.applicationId === finding.component && verification.branch !== undefined && verification.branch !== null && item.maintainedBranches.includes(verification.branch));
        if (bindings.length !== 1) throw new DomainError('SOURCE_VERIFICATION_MAINTAINED_BRANCH_REQUIRED');
      }
      const next = verifiedOccurrence(finding, previous, verification, evidence);
      const existing = await tx.verification.findUnique({ where: { id: verification.id } }); if (existing && digest(existing.data) !== digest(verification)) throw new DomainError('VERIFICATION_IDENTITY_CONFLICT');
      if (!existing) await tx.verification.create({ data: { id: verification.id, occurrenceId: previous.id, data: json(verification) } });
      if (verification.result === 'fail') {
        for (const row of await tx.plan.findMany({ where: { installationId: finding.scope.installationId } })) {
          const revision = await tx.planRevision.findUnique({ where: { planId_revision: { planId: row.id, revision: row.currentRevision } } });
          if (revision && planSchema.parse(revision.data).findingIds.includes(finding.id)) {
            await tx.campaign.update({ where: { id: row.campaignId }, data: { paused: true, generation: { increment: 1 } } });
            await audit(tx, actor, 'campaign.verification-stop', row.campaignId, { verificationId: verification.id });
          }
        }
      }
      await tx.occurrence.update({ where: { id: previous.id }, data: { data: json(next) } }); await audit(tx, actor, 'verification.recorded', previous.id, { verificationId: verification.id, result: verification.result });
    }); return verification.id;
  }
  async exception(actor: Actor, input: unknown): Promise<string> {
    const exception = exceptionSchema.parse(input); requirePermission(actor, 'exception', exception.scope);
    if (Date.parse(exception.expiresAt) <= Date.now()) throw new DomainError('EXCEPTION_ALREADY_EXPIRED');
    await this.db.$transaction(async tx => {
      for (const findingId of exception.findingIds) { const finding = await tx.finding.findUnique({ where: { id: findingId } }); if (!finding || !within(exception.scope, findingSchema.parse(finding.data).scope)) throw new DomainError('EXCEPTION_SCOPE_MISMATCH'); }
      await tx.exception.create({ data: { id: exception.id, installationId: exception.scope.installationId, expiresAt: new Date(exception.expiresAt), status: exception.status, data: json(exception) } }); await audit(tx, actor, 'exception.recorded', exception.id);
    }); return exception.id;
  }
  async assess(actor: Actor, input: unknown): Promise<string> {
    const request = assessmentRequestSchema.parse(input); requirePermission(actor, 'assess', request.scope);
    if (!request.targetIds.every(target => request.scope.targetIds.includes(target))) throw new DomainError('ASSESSMENT_TARGET_SCOPE');
    return this.db.$transaction(tx => enqueue(tx, actor, 'assessment', request.id, request, new Date(request.deadline)));
  }
  async assessVulnerabilities(actor: Actor, input: unknown): Promise<string> {
    const request = vulnerabilityAssessmentSchema.parse(input); requirePermission(actor, 'assess', request.scope);
    if (!request.scope.targetIds.includes(request.targetId)) throw new DomainError('ASSESSMENT_TARGET_SCOPE');
    return this.db.$transaction(tx => enqueue(tx, actor, 'vulnerabilities', request.id, request, new Date(request.deadline)));
  }
  async scan(actor: Actor, input: unknown): Promise<string> {
    const request = scanRequestSchema.parse(input); requirePermission(actor, 'assess', request.scope);
    if (!request.scope.targetIds.includes(request.workerTargetId) || !request.scope.applicationIds.includes(request.applicationId)) throw new DomainError('SCAN_SCOPE_MISMATCH');
    const repositoryRow = await this.db.entity.findUnique({ where: { id: request.repositoryId } }); const repository = repositoryRow ? entitySchema.parse(repositoryRow.data) : null;
    if (!repository || repository.kind !== 'repository' || repository.providerId !== request.providerId || repository.scope.installationId !== request.scope.installationId) throw new DomainError('REPOSITORY_NOT_AUTHORIZED');
    const bindings = (await this.db.entity.findMany({ where: { kind: 'source-binding', installationId: request.scope.installationId } })).map(row => entitySchema.parse(row.data)).filter(entity => entity.kind === 'source-binding' && entity.repositoryId === request.repositoryId && entity.applicationId === request.applicationId);
    const binding = bindings[0];
    if (bindings.length !== 1 || !binding || binding.kind !== 'source-binding' || !within(actor.scope, binding.scope)) throw new DomainError('UNIQUE_APPLICATION_SOURCE_BINDING_REQUIRED');
    if (!request.includedPaths.every(path => (path === '.' || safePath(path)) && binding.includedPaths.some(prefix => matchesPath(path, prefix)))) throw new DomainError('SCAN_PATHS_OUTSIDE_APPLICATION_SCOPE');
    if (!binding.modelPolicy.providerRefs.includes(request.sourcePolicy.providerRef) || request.sourcePolicy.allowRemoteModel && !binding.modelPolicy.allowRemote || request.sourcePolicy.allowRepositoryExecution && !binding.modelPolicy.allowExecution) throw new DomainError('SOURCE_DISCLOSURE_OR_EXECUTION_POLICY_DENIED');
    const bounded = { ...request, excludedPaths: [...new Set([...request.excludedPaths, ...binding.excludedPaths])] };
    return this.db.$transaction(tx => enqueue(tx, actor, 'scan', request.operationId, bounded, new Date(request.deadline)));
  }
  async profile(actor: Actor, input: unknown): Promise<string> {
    requirePermission(actor, 'policy', actor.scope); const profile = profileSchema.parse(input);
    await this.db.$transaction(async tx => { const existing = await tx.profile.findUnique({ where: { id_version: { id: profile.id, version: profile.version } } }); if (existing && digest(existing.data) !== digest(profile)) throw new DomainError('PROFILE_VERSION_IMMUTABLE'); if (!existing) await tx.profile.create({ data: { id: profile.id, version: profile.version, data: json(profile) } }); await audit(tx, actor, 'profile.published', profile.id, { version: profile.version }); }); return profile.id;
  }
  async timeline(actor: Actor) {
    requirePermission(actor, 'read', actor.scope);
    const plans = await this.db.plan.findMany({ where: { installationId: actor.scope.installationId }, take: 200 }); const result = [];
    for (const row of plans) { const plan = await this.plan(actor, row.id).catch((error: unknown) => { if (error instanceof DomainError && error.status === 403) return null; throw error; }); if (plan && within(actor.scope, plan.scope)) result.push({ plan, digest: digest(plan), status: row.status, jobs: await Promise.all((await this.db.job.findMany({ where: { kind: 'campaign', payload: { path: ['planId'], equals: plan.id } }, orderBy: { createdAt: 'desc' }, take: 100 })).filter(job => z.object({ revision: z.number() }).parse(job.payload).revision === plan.revision).map(job => this.job(actor, job.id))), publications: await this.db.publication.findMany({ where: { planId: row.id, revision: row.currentRevision } }), executions: (await this.db.execution.findMany({ where: { planId: row.id, revision: plan.revision } })).map(({ id, state, actionId, targetId, receipt }) => ({ id, state, actionId, targetId, receipt })), campaign: await this.db.campaign.findUnique({ where: { id: row.campaignId } }) }); }
    return result;
  }
  async job(actor: Actor, id: string) {
    const row = await this.db.job.findUnique({ where: { id } }); if (!row) throw new DomainError('NOT_FOUND', 404);
    const scope = z.object({ scope: scopeSchema }).parse(row.payload).scope; requirePermission(actor, 'read', scope);
    if (row.result !== null && ['source', 'preparation', 'scan', 'reconciliation', 'build-observation'].includes(row.kind)) requirePermission(actor, 'evidence', scope);
    return { id: row.id, kind: row.kind, status: row.status, progress: row.progress, deadline: row.deadline.toISOString(), cancelRequested: row.cancelRequested, result: row.result, error: row.error };
  }
  async reconcileJob(actor: Actor, id: string): Promise<string> {
    await this.job(actor, id);
    return this.db.$transaction(async tx => {
      await lock(tx, `job-observation:${id}`);
      const row = await tx.job.findUnique({ where: { id } });
      if (!row || row.status !== 'unknown' || !['assessment', 'vulnerabilities', 'scan', 'preparation', 'source', 'campaign', 'build-observation'].includes(row.kind)) throw new DomainError('JOB_RECONCILIATION_NOT_ELIGIBLE');
      const scope = z.object({ scope: scopeSchema }).parse(row.payload).scope; requirePermission(actor, 'recover', scope); requirePermission(actor, 'evidence', scope);
      const prior = await tx.job.findFirst({ where: { kind: 'reconciliation', installationId: scope.installationId, payload: { path: ['originalJobId'], equals: id } }, orderBy: { createdAt: 'desc' } });
      if (prior && ['queued', 'running'].includes(prior.status)) return prior.id;
      // Observation has its own bounded deadline and never renews the original
      // execution grant, clears cancellation, or requeues original work.
      const observationId = await enqueue(tx, actor, 'reconciliation', `${id}:${prior?.id ?? 'initial'}`, { originalJobId: id, scope }, new Date(Date.now() + 300000));
      await audit(tx, actor, 'job.reconciliation-requested', id, { observationJobId: observationId }); return observationId;
    });
  }
  async cancelJob(actor: Actor, id: string): Promise<void> {
    await this.job(actor, id); requirePermission(actor, 'assess', actor.scope);
    await this.db.$transaction(async tx => {
      const changed = await tx.job.updateMany({ where: { id, status: 'queued', result: { equals: Prisma.DbNull } }, data: { status: 'canceled', cancelRequested: true } });
      if (!changed.count) await tx.job.updateMany({ where: { id, status: 'queued' }, data: { status: 'unknown', cancelRequested: true } });
      await tx.job.update({ where: { id }, data: { cancelRequested: true } }); await audit(tx, actor, 'job.cancellation-requested', id);
    });
  }
  async prepare(actor: Actor, input: unknown): Promise<string> {
    const preparation = preparationSchema.parse(input);
    if (preparation.edits.some(edit => edit.content !== null && redact(edit.content) !== edit.content)) throw new DomainError('SENSITIVE_PATCH_CONTENT_REQUIRES_REDACTION');
    requirePermission(actor, 'prepare', preparation.scope);
    if (!preparation.scope.applicationIds.includes(preparation.applicationId) || !preparation.scope.targetIds.includes(preparation.workerTargetId)) throw new DomainError('PREPARATION_SCOPE_MISMATCH');
    const repository = await this.db.entity.findUnique({ where: { id: preparation.repositoryId } });
    const repo = repository ? entitySchema.parse(repository.data) : null;
    if (!repo || repo.kind !== 'repository' || repo.providerId !== preparation.providerId || repo.scope.installationId !== preparation.scope.installationId) throw new DomainError('REPOSITORY_NOT_AUTHORIZED');
    const bindings = (await this.db.entity.findMany({ where: { kind: 'source-binding', installationId: preparation.scope.installationId } })).map(row => entitySchema.parse(row.data)).filter(item => item.kind === 'source-binding' && item.applicationId === preparation.applicationId && item.repositoryId === preparation.repositoryId);
    if (bindings.length !== 1) throw new DomainError('UNIQUE_APPLICATION_SOURCE_BINDING_REQUIRED'); const binding = bindings[0];
    if (!binding || binding.kind !== 'source-binding' || !within(actor.scope, binding.scope) || !binding.maintainedBranches.includes(preparation.branch)) throw new DomainError('MAINTAINED_BRANCH_REQUIRED');
    if (!binding.modelPolicy.allowExecution) throw new DomainError('REPOSITORY_EXECUTION_NOT_AUTHORIZED');
    for (const edit of preparation.edits) if (!safePath(edit.path) || edit.path.split('/').includes('.git') || !binding.includedPaths.some(path => matchesPath(edit.path, path)) || binding.excludedPaths.some(path => matchesPath(edit.path, path)) || !preparation.includedPaths.some(path => matchesPath(edit.path, path)) || preparation.excludedPaths.some(path => matchesPath(edit.path, path))) throw new DomainError('PATCH_OUTSIDE_APPLICATION_SCOPE');
    return this.db.$transaction(async tx => {
      const jobId = await enqueue(tx, actor, 'preparation', preparation.id, preparation, new Date(preparation.deadline));
      const prior = await tx.preparation.findUnique({ where: { id: preparation.id } });
      if (prior && prior.requestDigest !== digest(preparation)) throw new DomainError('PREPARATION_IDENTITY_CONFLICT');
      if (!prior) await tx.preparation.create({ data: { id: preparation.id, installationId: preparation.scope.installationId, repositoryId: preparation.repositoryId, applicationId: preparation.applicationId, jobId, requestDigest: digest(preparation), data: json(preparation) } });
      await audit(tx, actor, 'source.preparation.requested', preparation.id, { baseCommit: preparation.baseCommit, editPaths: preparation.edits.map(edit => edit.path) }); return jobId;
    });
  }
  async source(actor: Actor, input: unknown): Promise<string> {
    const request = sourceRequestSchema.parse(input); requirePermission(actor, 'assess', request.scope); requirePermission(actor, 'evidence', request.scope);
    if (!request.scope.targetIds.includes(request.workerTargetId) || !request.scope.applicationIds.includes(request.applicationId)) throw new DomainError('SOURCE_SCOPE_MISMATCH');
    const bindings = (await this.db.entity.findMany({ where: { kind: 'source-binding', installationId: request.scope.installationId } })).map(row => entitySchema.parse(row.data)).filter(entity => entity.kind === 'source-binding' && entity.repositoryId === request.repositoryId && entity.applicationId === request.applicationId);
    const binding = bindings[0]; if (bindings.length !== 1 || !binding || binding.kind !== 'source-binding' || !within(actor.scope, binding.scope)) throw new DomainError('UNIQUE_APPLICATION_SOURCE_BINDING_REQUIRED');
    for (const path of request.paths) if (!safePath(path) || path.split('/').includes('.git') || !binding.includedPaths.some(prefix => matchesPath(path, prefix)) || binding.excludedPaths.some(prefix => matchesPath(path, prefix))) throw new DomainError('SOURCE_PATH_OUTSIDE_APPLICATION_SCOPE');
    return this.db.$transaction(tx => enqueue(tx, actor, 'source', request.id, request, new Date(request.deadline)));
  }
  private async authorized<T>(actor: Actor, plan: Plan, action: Action, work: (tx: Transaction) => Promise<T>): Promise<T> {
    requirePermission(actor, 'execute', plan.scope); requireActionPermission(actor, action, plan.scope); validateAction(action);
    return this.db.$transaction(async tx => {
      await lock(tx, `authority:${actor.scope.installationId}`); await lock(tx, `campaign:${plan.campaignId}`); await lock(tx, `plan:${plan.id}`);
      const current = await this.planIn(tx, actor, plan.id); if (digest(current) !== digest(plan)) throw new DomainError('PLAN_CHANGED'); await this.requirePublication(tx, plan);
      const campaign = await tx.campaign.findUnique({ where: { id: plan.campaignId } }); if (!campaign || campaign.paused) throw new DomainError('CAMPAIGN_PAUSED');
      if (Date.parse(plan.notBefore) > Date.now() || Date.parse(plan.expiresAt) <= Date.now()) throw new DomainError('OUTSIDE_EXECUTION_WINDOW');
      const authorization = await tx.authorization.findFirst({ where: { planId: plan.id, revision: plan.revision, digest: digest(plan), revoked: false, expiresAt: { gt: new Date() } } });
      if (!authorization) throw new DomainError('CURRENT_AUTHORIZATION_REQUIRED');
      if (authorization.policyId) { const row = await tx.policy.findUnique({ where: { id: authorization.policyId } }); const policy = row ? policySchema.parse(row.data) : null; const targets = (await tx.entity.findMany({ where: { id: { in: plan.actions.map(item => item.targetId) } } })).map(item => entitySchema.parse(item.data)); if (!policy || policy.revision !== authorization.policyRevision || !policyCovers(policy, plan, targets, new Date(), await this.recoveryEvidence(tx, plan))) throw new DomainError('POLICY_CHANGED'); }
      for (const id of action.dependsOn) {
        const predecessor = plan.actions.find(item => item.id === id);
        const execution = await tx.execution.findUnique({ where: { planId_revision_actionId: { planId: plan.id, revision: plan.revision, actionId: id } } });
        if (!predecessor || !execution || execution.state !== 'completed' || !execution.receipt || !receiptSchema.parse(execution.receipt).ownershipReleased) throw new DomainError('DEPENDENCY_NOT_VERIFIED');
        await this.requireActionVerifications(tx, predecessor, execution.createdAt);
      }
      if (action.targetId !== plan.canaryTargetId) {
        const canaries = plan.actions.filter(item => item.targetId === plan.canaryTargetId);
        for (const canary of canaries) {
          const execution = await tx.execution.findUnique({ where: { planId_revision_actionId: { planId: plan.id, revision: plan.revision, actionId: canary.id } } });
          if (!execution || execution.state !== 'completed') throw new DomainError('CANARY_NOT_COMPLETED');
          await this.requireActionVerifications(tx, canary, execution.createdAt);
        }
      }
      await lock(tx, `provider-resource:${action.targetId}`);
      if (await tx.execution.count({ where: { targetId: action.targetId, state: { in: ['queued', 'running', 'unknown'] }, NOT: { planId: plan.id, revision: plan.revision, actionId: action.id } } })) throw new DomainError('RESOURCE_ALREADY_OWNED');
      return work(tx);
    }, { timeout: 45000 });
  }
  private async providerEffect(actor: Actor, plan: Plan, action: Action, phase: string, input: unknown, effect: () => Promise<unknown>): Promise<unknown> {
    const key = { planId: plan.id, revision: plan.revision, actionId: action.id, phase };
    const reserved = await this.authorized(actor, plan, action, async tx => {
      const prior = await tx.providerEffect.findUnique({ where: { planId_revision_actionId_phase: key } });
      if (prior) { if (prior.requestDigest !== digest(input)) throw new DomainError('PROVIDER_EFFECT_IDENTITY_CONFLICT'); if (prior.state !== 'completed') throw new DomainError('UNKNOWN_PROVIDER_EFFECT_RECONCILE_ORIGINAL'); return { existing: true, value: prior.result, id: prior.id }; }
      const execution = await tx.execution.findUnique({ where: { id: digest([plan.id, plan.revision, action.id]) } });
      if (!execution || ['not-dispatched', 'completed', 'failed'].includes(execution.state)) throw new DomainError('PROVIDER_EXECUTION_NOT_ADMITTED');
      const row = await tx.providerEffect.create({ data: { id: randomUUID(), ...key, requestDigest: digest(input), state: 'unknown' } }); await audit(tx, actor, 'provider.effect.reserved', row.id, { phase, requestDigest: row.requestDigest }); return { existing: false, value: null, id: row.id };
    });
    if (reserved.existing) return z.object({ value: z.json() }).parse(reserved.value).value;
    return this.authorized(actor, plan, action, async tx => { const value = await effect(); await tx.providerEffect.update({ where: { id: reserved.id }, data: { state: 'completed', result: json({ value }) } }); await audit(tx, actor, 'provider.effect.completed', reserved.id, { phase }); return value; });
  }
  private async releaseUnreservedProviderOperation(actor: Actor, execution: { id: string; planId: string; revision: number; actionId: string; targetId: string; requestDigest: string }): Promise<Receipt | null> {
    return this.db.$transaction(async tx => {
      // providerEffect holds the same resource lock before reserving any write.
      // A concurrent phase must see this terminal receipt before admission.
      await lock(tx, `provider-resource:${execution.targetId}`);
      const current = await tx.execution.findUnique({ where: { id: execution.id } });
      if (!current || current.requestDigest !== execution.requestDigest) throw new DomainError('PROVIDER_OPERATION_IDENTITY_CONFLICT');
      if (current.receipt && ['completed', 'failed', 'not-dispatched'].includes(current.state)) return receiptSchema.parse(current.receipt);
      if (await tx.providerEffect.count({ where: { planId: execution.planId, revision: execution.revision, actionId: execution.actionId } })) return null;
      const receipt: Receipt = { operationId: execution.id, requestDigest: execution.requestDigest, targetId: execution.targetId, state: 'not-dispatched', evidenceIds: [], result: { reason: 'NO_PROVIDER_MUTATION_RESERVED' }, ownershipReleased: true, observedAt: new Date().toISOString() };
      await tx.execution.update({ where: { id: execution.id }, data: { state: receipt.state, receipt: json(receipt) } });
      await audit(tx, actor, 'provider.operation.not-dispatched', execution.id, { reason: 'NO_PROVIDER_MUTATION_RESERVED' }); return receipt;
    });
  }
  private async recordMergeObservation(actor: Actor, execution: { id: string; requestDigest: string; targetId: string }, changeId: string, merge: GitHubMergeOperation): Promise<Receipt> {
    return this.db.$transaction(async tx => {
      await lock(tx, `provider-merge-observation:${execution.id}`);
      const current = await tx.execution.findUnique({ where: { id: execution.id } }); if (!current || current.requestDigest !== execution.requestDigest) throw new DomainError('PROVIDER_MERGE_EXECUTION_CHANGED');
      if (current.receipt && ['completed', 'failed'].includes(current.state)) return receiptSchema.parse(current.receipt);
      const terminal = merge.state === 'merged' || merge.state === 'failed';
      const receipt: Receipt = { operationId: execution.id, requestDigest: execution.requestDigest, targetId: execution.targetId, state: merge.state === 'merged' ? 'completed' : merge.state === 'failed' ? 'failed' : 'queued', evidenceIds: [], result: { mergeOperation: merge, ...(merge.state === 'merged' ? { commit: merge.commit } : {}) }, ownershipReleased: terminal, observedAt: new Date().toISOString() };
      if (merge.state === 'merged') { const change = await tx.repositoryChange.findUnique({ where: { id: changeId } }); if (!change) throw new DomainError('ORIGINAL_REPOSITORY_CHANGE_MISSING'); const original = z.record(z.string(), z.json()).parse(change.data); await tx.repositoryChange.update({ where: { id: changeId }, data: { state: 'merged', data: json({ ...original, commit: merge.commit, mergeOperation: merge }) } }); }
      await tx.execution.update({ where: { id: execution.id }, data: { state: receipt.state, receipt: json(receipt) } });
      await audit(tx, actor, 'provider.merge.observed', execution.id, { state: merge.state, providerRequestId: merge.requestId }); return receipt;
    });
  }
  private async reconcileRepositoryWrite(actor: Actor, execution: { id: string; planId: string; revision: number; actionId: string; targetId: string; requestDigest: string; request: unknown }, changeId: string): Promise<Receipt | null> {
    const github = this.github; if (!github) return null;
    const request = z.object({ action: z.object({ expectedRevision: z.string(), patchDigest: z.string() }) }).parse(execution.request);
    const change = await this.db.preparation.findUnique({ where: { id: changeId } }); if (!change?.result) return null;
    const preparation = preparationSchema.parse(change.data); const prepared = preparationResultSchema.parse(change.result); requirePermission(actor, 'read', preparation.scope);
    if (preparation.repositoryId !== execution.targetId || preparation.baseCommit !== request.action.expectedRevision || !prepared.validated || prepared.patchDigest !== request.action.patchDigest || digest(prepared.edits) !== prepared.patchDigest) throw new DomainError('ORIGINAL_PREPARATION_IDENTITY_CHANGED');
    const row = await this.db.entity.findUnique({ where: { id: execution.targetId } }); const repository = row ? entitySchema.parse(row.data) : null;
    if (!repository || repository.kind !== 'repository' || repository.providerId !== preparation.providerId) throw new DomainError('ORIGINAL_REPOSITORY_MISSING'); requirePermission(actor, 'read', repository.scope);
    const key = { planId: execution.planId, revision: execution.revision, actionId: execution.actionId };
    const phases = await this.db.providerEffect.findMany({ where: key });
    const treePhase = phases.find(phase => phase.phase === 'tree' && phase.state === 'completed');
    const commitPhase = phases.find(phase => phase.phase === 'commit' && phase.state === 'completed');
    const branchPhase = phases.find(phase => phase.phase === 'branch' && phase.state === 'completed');
    const pullPhase = phases.find(phase => phase.phase === 'pull-request');
    if (!treePhase || !commitPhase || !branchPhase || !pullPhase) return null;
    const tree = z.object({ value: z.string().regex(/^[a-f0-9]{40,64}$/) }).parse(treePhase.result).value;
    const commit = z.object({ value: z.string().regex(/^[a-f0-9]{40,64}$/) }).parse(commitPhase.result).value;
    const branch = remediationBranch(preparation.id);
    if (treePhase.requestDigest !== digest({ patchDigest: prepared.patchDigest, baseCommit: preparation.baseCommit }) || commitPhase.requestDigest !== digest({ tree, baseCommit: preparation.baseCommit }) || branchPhase.requestDigest !== digest({ branch, commit }) || z.object({ value: z.string() }).parse(branchPhase.result).value !== `refs/heads/${branch}` || pullPhase.requestDigest !== digest({ branch, base: preparation.branch, commit })) throw new DomainError('ORIGINAL_PROVIDER_PHASE_IDENTITY_CHANGED');
    const pull = await github.findPullRequest(repository.providerId, { branch, base: preparation.branch, headCommit: commit, operationId: preparation.id });
    if (!pull) return null; // A missing result cannot establish absence or authorize replay.
    const result = { number: pull.number, url: pull.url, headCommit: pull.headCommit };
    const receipt: Receipt = { operationId: execution.id, requestDigest: execution.requestDigest, targetId: repository.id, state: 'completed', evidenceIds: [], result, ownershipReleased: true, observedAt: new Date().toISOString() };
    return this.db.$transaction(async tx => {
      await lock(tx, `provider-observation:${execution.id}`);
      const current = await tx.execution.findUnique({ where: { id: execution.id } }); if (!current || current.requestDigest !== execution.requestDigest) throw new DomainError('PROVIDER_OPERATION_IDENTITY_CONFLICT');
      if (current.state === 'completed' && current.receipt) return receiptSchema.parse(current.receipt);
      const phase = await tx.providerEffect.findUniqueOrThrow({ where: { id: pullPhase.id } });
      if (phase.requestDigest !== pullPhase.requestDigest || phase.state === 'completed' && digest(phase.result) !== digest({ value: result })) throw new DomainError('ORIGINAL_PROVIDER_PHASE_IDENTITY_CHANGED');
      const existing = await tx.repositoryChange.findUnique({ where: { id: preparation.id } }); if (existing && (existing.repositoryId !== repository.id || existing.providerIdentity !== String(pull.number))) throw new DomainError('LINKED_PULL_REQUEST_IDENTITY_CHANGED');
      await tx.providerEffect.update({ where: { id: phase.id }, data: { state: 'completed', result: json({ value: result }) } });
      await tx.repositoryChange.upsert({ where: { id: preparation.id }, create: { id: preparation.id, installationId: repository.scope.installationId, planId: execution.planId, revision: execution.revision, repositoryId: repository.id, baseCommit: preparation.baseCommit, patchDigest: prepared.patchDigest, state: pull.state === 'open' ? 'pull-request' : 'closed', providerIdentity: String(pull.number), data: json(result) }, update: {} });
      await tx.execution.update({ where: { id: execution.id }, data: { state: 'completed', receipt: json(receipt) } });
      await audit(tx, actor, 'provider.pull-request.observed', execution.id, { phaseId: phase.id, pullNumber: pull.number }); return receipt;
    });
  }
  private async dispatchRepository(actor: Actor, plan: Plan, action: Action): Promise<Receipt> {
    const github = this.github; if (!github) throw new DomainError('GITHUB_PROVIDER_UNCONFIGURED');
    const row = await this.db.entity.findUnique({ where: { id: action.targetId } }); const repository = row ? entitySchema.parse(row.data) : null;
    if (!repository || repository.kind !== 'repository' || repository.scope.installationId !== plan.scope.installationId) throw new DomainError('REPOSITORY_OUTSIDE_PLAN_SCOPE');
    const parameters = z.object({ changeId: z.string() }).passthrough().parse(action.parameters); const change = await this.db.preparation.findUnique({ where: { id: parameters.changeId } });
    if (!change || !change.result) throw new DomainError('VALIDATED_PREPARATION_REQUIRED');
    const preparation = preparationSchema.parse(change.data); const prepared = preparationResultSchema.parse(change.result);
    if (!plan.scope.applicationIds.includes(preparation.applicationId) || !prepared.validated || prepared.baseCommit !== action.expectedRevision || prepared.patchDigest !== action.patchDigest || digest(prepared.edits) !== prepared.patchDigest || preparation.repositoryId !== repository.id) throw new DomainError('PATCH_OR_SOURCE_REVISION_CHANGED');
    assertTarget(action, repository);
    if (action.preconditions['branch'] !== preparation.branch || action.parameters['repositoryId'] !== undefined && action.parameters['repositoryId'] !== repository.id) throw new DomainError('AUTHORITATIVE_REPOSITORY_SCOPE_MISMATCH');
    const operationId = digest([plan.id, plan.revision, action.id]);
    const request = { planId: plan.id, revision: plan.revision, planDigest: digest(plan), action };
    const terminal = await this.authorized(actor, plan, action, async tx => {
      const prior = await tx.execution.findUnique({ where: { id: operationId } });
      if (prior && prior.requestDigest !== digest(request)) throw new DomainError('PROVIDER_OPERATION_IDENTITY_CONFLICT');
      if (prior?.receipt && ['completed', 'failed', 'not-dispatched'].includes(prior.state)) return receiptSchema.parse(prior.receipt);
      if (!prior) await tx.execution.create({ data: { id: operationId, planId: plan.id, revision: plan.revision, actionId: action.id, targetId: repository.id, requestDigest: digest(request), request: json(request), state: 'unknown', dispatchGeneration: 0 } });
      return null;
    });
    if (terminal) return terminal;
    const finish = async (result: Record<string, z.infer<ReturnType<typeof z.json>>>): Promise<Receipt> => {
      const receipt: Receipt = { operationId, requestDigest: digest(request), targetId: repository.id, state: 'completed', evidenceIds: [], result, ownershipReleased: true, observedAt: new Date().toISOString() };
      await this.db.execution.update({ where: { id: operationId }, data: { state: 'completed', receipt: json(receipt) } }); return receipt;
    };
    const branch = remediationBranch(preparation.id);
    if (action.class === 'repository-write') {
      if (await github.resolve(repository.providerId, preparation.branch) !== preparation.baseCommit) throw new DomainError('SOURCE_BASE_CHANGED');
      const tree = z.string().parse(await this.providerEffect(actor, plan, action, 'tree', { patchDigest: prepared.patchDigest, baseCommit: prepared.baseCommit }, () => github.createTree(repository.providerId, prepared)));
      const commit = z.string().parse(await this.providerEffect(actor, plan, action, 'commit', { tree, baseCommit: prepared.baseCommit }, () => github.createCommit(repository.providerId, prepared.baseCommit, tree, preparation.id)));
      await this.providerEffect(actor, plan, action, 'branch', { branch, commit }, () => github.createBranch(repository.providerId, branch, commit));
      const pull = z.object({ number: z.number(), url: z.url(), headCommit: z.string() }).parse(await this.providerEffect(actor, plan, action, 'pull-request', { branch, base: preparation.branch, commit }, () => github.createPullRequest(repository.providerId, branch, preparation.branch, preparation.id)));
      if (pull.headCommit !== commit) throw new DomainError('CREATED_PULL_REQUEST_HEAD_CHANGED');
      await this.db.repositoryChange.upsert({ where: { id: preparation.id }, create: { id: preparation.id, installationId: plan.scope.installationId, planId: plan.id, revision: plan.revision, repositoryId: repository.id, baseCommit: prepared.baseCommit, patchDigest: prepared.patchDigest, state: 'pull-request', providerIdentity: String(pull.number), data: json(pull) }, update: {} });
      return finish(pull);
    }
    if (action.class === 'merge') {
      const sourceChange = await this.db.repositoryChange.findUnique({ where: { id: preparation.id } }); if (!sourceChange?.providerIdentity) throw new DomainError('LINKED_PULL_REQUEST_REQUIRED');
      const parameters = z.object({ headCommit: z.string(), checksDigest: z.string() }).passthrough().parse(action.parameters);
      const linked = z.object({ headCommit: z.string() }).passthrough().parse(sourceChange.data); if (linked.headCommit !== parameters.headCommit) throw new DomainError('LINKED_PULL_REQUEST_HEAD_CHANGED');
      const checks = await github.checks(repository.providerId, parameters.headCommit); if (digest(checks) !== parameters.checksDigest) throw new DomainError('REPOSITORY_CHECKS_CHANGED');
      const result = await this.providerEffect(actor, plan, action, 'merge', { pull: sourceChange.providerIdentity, head: parameters.headCommit, checksDigest: parameters.checksDigest }, () => github.merge(repository.providerId, Number(sourceChange.providerIdentity), parameters.headCommit));
      // Retain already completed legacy receipts without issuing a new request.
      if (typeof result === 'string') { const commit = z.string().regex(/^[a-f0-9]{40}$/).parse(result); const original = z.record(z.string(), z.json()).parse(sourceChange.data); await this.db.repositoryChange.update({ where: { id: preparation.id }, data: { state: 'merged', data: json({ ...original, commit }) } }); return finish({ commit }); }
      const merge = githubMergeOperationSchema.parse(result);
      if (merge.providerId !== repository.providerId || merge.pullNumber !== Number(sourceChange.providerIdentity) || merge.headCommit !== parameters.headCommit) throw new DomainError('PROVIDER_MERGE_IDENTITY_CHANGED');
      const observed = merge.state === 'merged' || merge.state === 'enqueued' ? await github.observeMerge(repository.providerId, merge) : merge;
      return this.recordMergeObservation(actor, { id: operationId, requestDigest: digest(request), targetId: repository.id }, preparation.id, observed);
    }
    throw new DomainError('UNSUPPORTED_PROVIDER_ACTION');
  }
}
