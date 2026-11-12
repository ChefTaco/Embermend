import { buildObservationRequestSchema, buildSchema, entitySchema, type Actor, type Build, type BuildObservationRequest } from '@hivemagnus/embermend-contracts';
import { audit, digest, enqueue, json, lock, within, type Database, type Transaction } from '@hivemagnus/embermend-store';
import type { GitHubClient } from '@hivemagnus/embermend-integrations';
import { DomainError, requirePermission } from './authorization.js';

export class Builds {
  constructor(private readonly db: Database, private readonly github?: GitHubClient) {}
  private async binding(tx: Transaction, actor: Actor, request: BuildObservationRequest) {
    requirePermission(actor, 'read', request.scope);
    if (!request.scope.applicationIds.includes(request.applicationId)) throw new DomainError('BUILD_APPLICATION_SCOPE_REQUIRED');
    const rows = await tx.entity.findMany({ where: { installationId: request.scope.installationId, OR: [{ id: request.repositoryId }, { id: request.sourceRevisionId }, { kind: 'source-binding' }] } });
    const entities = rows.map(row => entitySchema.parse(row.data));
    const repository = entities.find(entity => entity.id === request.repositoryId);
    const source = entities.find(entity => entity.id === request.sourceRevisionId);
    const bindings = entities.filter(entity => entity.kind === 'source-binding' && entity.repositoryId === request.repositoryId && entity.applicationId === request.applicationId);
    const binding = bindings[0];
    if (!repository || repository.kind !== 'repository' || repository.providerInstance !== 'https://github.com' || !within(request.scope, repository.scope) || !source || source.kind !== 'source-revision' || source.repositoryId !== repository.id || !within(request.scope, source.scope)) throw new DomainError('BUILD_REGISTERED_SOURCE_REQUIRED');
    if (bindings.length !== 1 || !binding || binding.kind !== 'source-binding' || !within(request.scope, binding.scope) || !source.branch || !binding.maintainedBranches.includes(source.branch) || !binding.buildDefinitions.includes(request.workflowPath)) throw new DomainError('BUILD_DEFINITION_OR_BRANCH_NOT_AUTHORIZED');
    return { repository, source, branch: source.branch };
  }
  async request(actor: Actor, raw: unknown): Promise<string> {
    const request = buildObservationRequestSchema.parse(raw);
    requirePermission(actor, 'assess', request.scope); requirePermission(actor, 'evidence', request.scope);
    if (!this.github) throw new DomainError('GITHUB_PROVIDER_UNCONFIGURED');
    if (Date.parse(request.deadline) <= Date.now()) throw new DomainError('BUILD_OBSERVATION_DEADLINE_EXPIRED');
    return this.db.$transaction(async tx => {
      await this.binding(tx, actor, request);
      const id = await enqueue(tx, actor, 'build-observation', request.id, request, new Date(request.deadline));
      await audit(tx, actor, 'build.observation-requested', request.id, { jobId: id, providerRunId: request.providerRunId, runAttempt: request.runAttempt }); return id;
    });
  }
  async list(actor: Actor): Promise<Build[]> {
    requirePermission(actor, 'read', actor.scope); requirePermission(actor, 'evidence', actor.scope);
    return (await this.db.build.findMany({ where: { installationId: actor.scope.installationId }, orderBy: { id: 'asc' }, take: 1000 })).map(row => buildSchema.parse(row.data)).filter(build => within(actor.scope, build.scope));
  }
  /** Observation performs only provider GETs. It cannot dispatch, retry or cancel a build. */
  async observe(actor: Actor, raw: unknown, lease: { jobId: string; owner: string; observeOnly: boolean }, signal: AbortSignal): Promise<Build> {
    const request = buildObservationRequestSchema.parse(raw);
    requirePermission(actor, lease.observeOnly ? 'recover' : 'assess', request.scope); requirePermission(actor, 'evidence', request.scope);
    const github = this.github; if (!github) throw new DomainError('GITHUB_PROVIDER_UNCONFIGURED');
    const bound = await this.db.$transaction(tx => this.binding(tx, actor, request));
    signal.throwIfAborted();
    const run = await github.buildRun(bound.repository.providerId, { runId: request.providerRunId, runAttempt: request.runAttempt, workflowId: request.workflowId, workflowPath: request.workflowPath, sourceCommit: bound.source.commit, branch: bound.branch });
    signal.throwIfAborted();
    return this.db.$transaction(async tx => {
      await lock(tx, `job:${lease.jobId}`);
      const fenced = await tx.job.updateMany({ where: { id: lease.jobId, status: 'running', leaseOwner: lease.owner, leaseUntil: { gt: new Date() }, deadline: { gt: new Date() }, cancelRequested: false }, data: { progress: 0.5 } });
      if (!fenced.count) throw new DomainError('BUILD_OBSERVATION_LEASE_LOST_OR_CANCELED');
      const job = await tx.job.findUnique({ where: { id: lease.jobId } });
      if (!job || job.status !== 'running' || job.leaseOwner !== lease.owner || !job.leaseUntil || job.leaseUntil <= new Date() || job.deadline <= new Date() || job.cancelRequested) throw new DomainError('BUILD_OBSERVATION_LEASE_LOST_OR_CANCELED');
      // Recheck standing source access after the provider read. No result obtained
      // under a changed binding is projected into authoritative product records.
      const current = await this.binding(tx, actor, request);
      if (digest(current) !== digest(bound)) throw new DomainError('BUILD_SOURCE_BINDING_CHANGED');
      const id = digest([request.scope.installationId, request.repositoryId, request.providerRunId, request.runAttempt]);
      await lock(tx, `build:${id}`);
      const row = await tx.build.findUnique({ where: { id } }); const previous = row ? buildSchema.parse(row.data) : null;
      if (previous && digest([previous.scope, previous.applicationId, previous.sourceRevisionId, previous.workflowId, previous.workflowPath, previous.sourceCommit]) !== digest([request.scope, request.applicationId, request.sourceRevisionId, request.workflowId, request.workflowPath, bound.source.commit])) throw new DomainError('BUILD_IDENTITY_CONFLICT');
      if (previous?.status === 'completed' && (run.status === 'completed' && run.conclusion !== previous.conclusion || run.status !== 'completed' && Date.parse(run.updated_at) >= Date.parse(previous.providerUpdatedAt))) throw new DomainError('BUILD_TERMINAL_STATE_CONFLICT');
      const evidenceId = digest([id, run]); const observedAt = new Date().toISOString();
      const content = { providerRunId: run.id, runAttempt: run.run_attempt, workflowId: run.workflow_id, workflowPath: run.path, sourceCommit: run.head_sha, branch: run.head_branch, status: run.status, conclusion: run.conclusion, providerUpdatedAt: run.updated_at, providerUrl: run.html_url, artifactProvenance: 'unestablished' };
      if (!await tx.evidence.findUnique({ where: { id: evidenceId } })) await tx.evidence.create({ data: { id: evidenceId, installationId: request.scope.installationId, subjectId: id, digest: digest(content), data: json({ id: evidenceId, scope: request.scope, subjectId: id, method: 'github-workflow-attempt-read.v1', observedAt, digest: digest(content), content, sensitivity: 'ordinary', source: 'github-actions' }) } });
      const next = buildSchema.parse({ id, scope: request.scope, repositoryId: request.repositoryId, applicationId: request.applicationId, sourceRevisionId: request.sourceRevisionId, sourceCommit: bound.source.commit, providerRunId: run.id, runAttempt: run.run_attempt, workflowId: run.workflow_id, workflowPath: run.path, status: run.status, conclusion: run.conclusion, providerUpdatedAt: run.updated_at, observedAt, providerUrl: run.html_url, evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), evidenceId])], artifactProvenance: 'unestablished' });
      const ranks = { requested: 0, pending: 1, queued: 2, waiting: 3, in_progress: 4, completed: 5 };
      const stale = previous && (Date.parse(previous.providerUpdatedAt) > Date.parse(run.updated_at) || Date.parse(previous.providerUpdatedAt) === Date.parse(run.updated_at) && ranks[previous.status] > ranks[run.status]);
      const retained = stale ? { ...previous, evidenceIds: next.evidenceIds } : next;
      await tx.build.upsert({ where: { id }, create: { id, installationId: request.scope.installationId, repositoryId: request.repositoryId, sourceCommit: next.sourceCommit, providerRunId: String(run.id), providerAttempt: run.run_attempt, status: retained.status, data: json(retained) }, update: { status: retained.status, data: json(retained) } });
      await audit(tx, actor, 'build.observed', id, { jobId: job.id, evidenceId, status: retained.status });
      return retained;
    });
  }
}
