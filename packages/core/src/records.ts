import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { observationSchema, relationshipSchema, profileAssignmentSchema, profileSchema, entitySchema, evidenceSchema, findingSchema, occurrenceSchema, planSchema, verificationSchema, exceptionSchema, scheduleSchema, assessmentRequestSchema, vulnerabilityAssessmentSchema, scanRequestSchema, scopeSchema, type Actor } from '@hivemagnus/embermend-contracts';
import { audit, digest, json, lock, within, type Database, type Transaction } from '@hivemagnus/embermend-store';
import { DomainError, requirePermission } from './authorization.js';
import { visibleOccurrences } from './occurrence-access.js';
import { LEGACY_LIST_LIMITS, listPage, scopedPositions, scopedRelationshipPositions, type ListQuery, type Page } from './listing.js';

type Relationship = z.infer<typeof relationshipSchema>;
type ProfileAssignment = z.infer<typeof profileAssignmentSchema>;
type Exception = z.infer<typeof exceptionSchema>;

export class Records {
  constructor(private readonly db: Database) {}
  private async entitiesIn(tx: Transaction, actor: Actor, ids: readonly string[]): Promise<void> {
    for (const id of ids) { const row = await tx.entity.findUnique({ where: { id } }); if (!row || !within(actor.scope, entitySchema.parse(row.data).scope)) throw new DomainError('RECORD_ENTITY_OUTSIDE_SCOPE'); }
  }
  async relationship(actor: Actor, input: unknown): Promise<string> {
    const value = relationshipSchema.parse(input); requirePermission(actor, 'ingest', value.scope);
    return this.db.$transaction(async tx => {
      await lock(tx, `relationship-id:${value.id}`); await lock(tx, `relationship-edge:${value.fromId}:${value.toId}:${value.kind}`);
      await this.entitiesIn(tx, { ...actor, scope: value.scope }, [value.fromId, value.toId]);
      for (const id of value.provenance.evidenceIds) { const evidence = await tx.evidence.findUnique({ where: { id } }); if (!evidence || !within(value.scope, evidenceSchema.parse(evidence.data).scope)) throw new DomainError('RELATIONSHIP_EVIDENCE_OUTSIDE_SCOPE'); }
      if (value.provenance.assurance === 'established' && !value.provenance.evidenceIds.length) throw new DomainError('ESTABLISHED_RELATIONSHIP_REQUIRES_EVIDENCE');
      const named = await tx.relationship.findUnique({ where: { id: value.id } }); if (named && digest(named.provenance) !== digest(value)) throw new DomainError('RELATIONSHIP_PROVENANCE_IMMUTABLE');
      const prior = await tx.relationship.findUnique({ where: { fromId_toId_kind: { fromId: value.fromId, toId: value.toId, kind: value.kind } } });
      if (prior) {
        requirePermission(actor, 'ingest', relationshipSchema.parse(prior.provenance).scope);
        if (prior.id !== value.id) {
          const id = digest(['relationship-evidence', prior.id, value.scope, value.provenance]);
          const observation = { id, scope: value.scope, source: 'relationship-evidence', sourceEventId: id, subjectId: value.fromId, type: 'relationship-evidence', observedAt: value.provenance.observedAt, evidenceIds: value.provenance.evidenceIds, data: { relationshipId: prior.id } };
          if (!await tx.observation.findUnique({ where: { id } })) await tx.observation.create({ data: { id, installationId: value.scope.installationId, subjectId: value.fromId, source: observation.source, sourceEventId: id, observedAt: new Date(observation.observedAt), data: json(observation) } });
          await audit(tx, actor, 'relationship.corroborated', prior.id, { observationId: id });
        }
        return prior.id;
      }
      await tx.relationship.create({ data: { id: value.id, fromId: value.fromId, toId: value.toId, kind: value.kind, provenance: json(value) } });
      await audit(tx, actor, 'relationship.recorded', value.id); return value.id;
    });
  }
  async relationships(actor: Actor): Promise<Relationship[]> { return [...(await this.relationshipsPage(actor, { after: undefined, limit: LEGACY_LIST_LIMITS.relationships })).data]; }
  /** Relationships whose two entities and own scope the actor can read, by ascending ID. */
  async relationshipsPage(actor: Actor, query: ListQuery): Promise<Page<Relationship>> {
    requirePermission(actor, 'read', actor.scope);
    const positions = await scopedRelationshipPositions(this.db, actor.scope, query);
    const rows = await this.db.relationship.findMany({ where: { id: { in: positions.slice(0, query.limit).map(position => position.id) } } });
    return listPage(positions, new Map(rows.map(row => [row.id, relationshipSchema.parse(row.provenance)] as const).filter(([, value]) => within(actor.scope, value.scope))), query, 'id');
  }
  async observation(actor: Actor, input: unknown): Promise<string> {
    const value = observationSchema.parse(input); requirePermission(actor, 'ingest', value.scope);
    if (Date.parse(value.observedAt) > Date.now() + 120000) throw new DomainError('FUTURE_OBSERVATION');
    // Observations reference sanitized evidence instead of accepting arbitrary
    // source bodies that could bypass the evidence disclosure boundary.
    if (Object.keys(value.data).length) throw new DomainError('OBSERVATION_BODY_REQUIRES_EVIDENCE');
    return this.db.$transaction(async tx => {
      await lock(tx, `observation:${value.scope.installationId}:${value.source}:${value.sourceEventId}`);
      await this.entitiesIn(tx, { ...actor, scope: value.scope }, [value.subjectId]);
      for (const id of value.evidenceIds) { const evidence = await tx.evidence.findUnique({ where: { id } }); if (!evidence || !within(value.scope, evidenceSchema.parse(evidence.data).scope)) throw new DomainError('OBSERVATION_EVIDENCE_OUTSIDE_SCOPE'); }
      const prior = await tx.observation.findUnique({ where: { installationId_source_sourceEventId: { installationId: value.scope.installationId, source: value.source, sourceEventId: value.sourceEventId } } });
      if (prior) { if (digest(prior.data) !== digest({ ...value, id: prior.id })) throw new DomainError('OBSERVATION_DELIVERY_CONFLICT'); return prior.id; }
      await tx.observation.create({ data: { id: value.id, source: value.source, sourceEventId: value.sourceEventId, installationId: value.scope.installationId, subjectId: value.subjectId, data: json(value), observedAt: new Date(value.observedAt) } }); await audit(tx, actor, 'observation.recorded', value.id); return value.id;
    });
  }
  async assignment(actor: Actor, input: unknown): Promise<string> {
    const value = profileAssignmentSchema.parse(input); requirePermission(actor, 'policy', value.scope);
    if (!value.targetIds.every(id => value.scope.targetIds.includes(id))) throw new DomainError('PROFILE_TARGET_SCOPE');
    await this.db.$transaction(async tx => {
      await this.entitiesIn(tx, { ...actor, scope: value.scope }, value.targetIds);
      const profile = await tx.profile.findUnique({ where: { id_version: { id: value.profileId, version: value.profileVersion } } }); if (!profile) throw new DomainError('PROFILE_VERSION_UNAVAILABLE'); profileSchema.parse(profile.data);
      if (value.supersedes) { const previous = await tx.profileAssignment.findUnique({ where: { id: value.supersedes } }); if (!previous || !within(value.scope, profileAssignmentSchema.parse(previous.data).scope)) throw new DomainError('PROFILE_SUPERSESSION_SCOPE'); }
      const prior = await tx.profileAssignment.findUnique({ where: { id: value.id } }); if (prior && digest(prior.data) !== digest(value)) throw new DomainError('PROFILE_ASSIGNMENT_IMMUTABLE');
      if (!prior) await tx.profileAssignment.create({ data: { id: value.id, installationId: value.scope.installationId, profileId: value.profileId, profileVersion: value.profileVersion, data: json(value) } });
      await audit(tx, actor, 'profile.assigned', value.id, { impact: value.impact });
    }); return value.id;
  }
  async assignments(actor: Actor): Promise<ProfileAssignment[]> { return [...(await this.assignmentsPage(actor, { after: undefined, limit: LEGACY_LIST_LIMITS.assignments })).data]; }
  async assignmentsPage(actor: Actor, query: ListQuery): Promise<Page<ProfileAssignment>> {
    requirePermission(actor, 'read', actor.scope);
    const positions = await scopedPositions(this.db, 'ProfileAssignment', 'id', actor.scope, query);
    const rows = await this.db.profileAssignment.findMany({ where: { id: { in: positions.slice(0, query.limit).map(position => position.id) } } });
    return listPage(positions, new Map(rows.map(row => [row.id, profileAssignmentSchema.parse(row.data)] as const).filter(([, value]) => within(actor.scope, value.scope))), query, 'id');
  }
  async exceptions(actor: Actor): Promise<Exception[]> { return [...(await this.exceptionsPage(actor, { after: undefined, limit: LEGACY_LIST_LIMITS.exceptions })).data]; }
  async exceptionsPage(actor: Actor, query: ListQuery): Promise<Page<Exception>> {
    requirePermission(actor, 'read', actor.scope);
    const positions = await scopedPositions(this.db, 'Exception', 'id', actor.scope, query);
    const rows = await this.db.exception.findMany({ where: { id: { in: positions.slice(0, query.limit).map(position => position.id) } } });
    return listPage(positions, new Map(rows.map(row => [row.id, exceptionSchema.parse(row.data)] as const).filter(([, value]) => within(actor.scope, value.scope))), query, 'id');
  }
  async schedule(actor: Actor, input: unknown): Promise<string> {
    const value = scheduleSchema.parse(input); requirePermission(actor, 'policy', value.scope); requirePermission(actor, 'assess', value.scope);
    const payload = value.kind === 'assessment' ? assessmentRequestSchema.parse(value.payload) : value.kind === 'vulnerabilities' ? vulnerabilityAssessmentSchema.parse(value.payload) : scanRequestSchema.parse(value.payload);
    if (!within(value.scope, payload.scope)) throw new DomainError('SCHEDULE_PAYLOAD_SCOPE');
    await this.db.$transaction(async tx => {
      await lock(tx, `schedule:${value.id}`);
      const old = await tx.schedule.findUnique({ where: { id: value.id } }); if (old && !within(actor.scope, scopeSchema.parse(z.object({ scope: scopeSchema }).parse(old.actor).scope))) throw new DomainError('SCHEDULE_OUTSIDE_SCOPE');
      const data = { installationId: value.scope.installationId, actor: json({ ...actor, scope: value.scope, permissions: [...actor.permissions] }), kind: value.kind, payload: json(payload), intervalSeconds: value.intervalSeconds, nextAt: new Date(value.nextAt), enabled: value.enabled };
      await tx.schedule.upsert({ where: { id: value.id }, create: { id: value.id, ...data }, update: data }); await audit(tx, actor, 'schedule.configured', value.id);
    }); return value.id;
  }
  async campaignReport(actor: Actor, campaignId: string) {
    requirePermission(actor, 'read', actor.scope);
    const campaign = await this.db.campaign.findUnique({ where: { id: campaignId } }); if (!campaign || campaign.installationId !== actor.scope.installationId) throw new DomainError('NOT_FOUND', 404);
    const plans = []; const reportedFindingIds = new Set<string>();
    for (const row of await this.db.plan.findMany({ where: { campaignId } })) {
      const revision = await this.db.planRevision.findUnique({ where: { planId_revision: { planId: row.id, revision: row.currentRevision } } }); if (!revision) throw new DomainError('PLAN_REVISION_MISSING');
      const plan = planSchema.parse(revision.data); plan.findingIds.forEach(id => reportedFindingIds.add(id)); requirePermission(actor, 'read', plan.scope);
      const findings = [];
      for (const id of plan.findingIds) {
        const findingRow = await this.db.finding.findUnique({ where: { id } }); if (!findingRow) throw new DomainError('FINDING_MISSING');
        const finding = findingSchema.parse(findingRow.data); requirePermission(actor, 'read', finding.scope);
        const occurrences = await visibleOccurrences(this.db, actor, (await this.db.occurrence.findMany({ where: { findingId: id } })).map(item => occurrenceSchema.parse(item.data)));
        const verifications = (await this.db.verification.findMany({ where: { occurrenceId: { in: occurrences.map(item => item.id) } } })).map(item => verificationSchema.parse(item.data));
        findings.push({ finding, occurrences, verifications });
      }
      const executions = (await this.db.execution.findMany({ where: { planId: row.id, revision: plan.revision } })).map(item => ({ id: item.id, revision: item.revision, actionId: item.actionId, state: item.state, receipt: item.receipt }));
      plans.push({ plan, digest: revision.digest, status: row.status, publications: await this.db.publication.findMany({ where: { planId: row.id, revision: plan.revision } }), executions, findings });
    }
    return { reportId: randomUUID(), generatedAt: new Date().toISOString(), campaign, plans, exceptions: (await this.exceptions(actor)).filter(item => item.findingIds.some(id => reportedFindingIds.has(id))) };
  }
}
