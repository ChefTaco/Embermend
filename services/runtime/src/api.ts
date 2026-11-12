import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { Actor } from '@hivemagnus/embermend-contracts';
import { VERSION } from '@hivemagnus/embermend-contracts';
import { DomainError, auditExport, auditExportInstallation, hiveEventFeed, requirePermission, type Embermend } from '@hivemagnus/embermend-core';
import { parseFeedQuery } from '@hivemagnus/hive-common/events';

export type Authenticate = (token: string) => Promise<Actor>;
export interface ApiOptions {
  /** The configured kind of an audit actor, used for audit rows written before the kind was recorded. */
  auditActorKind?: (actorId: string) => Actor['kind'] | undefined;
}
export function createApi(service: Embermend, authenticate: Authenticate, options: ApiOptions = {}): Hono<{ Variables: { actor: Actor } }> {
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: c => c.json({ error: 'REQUEST_TOO_LARGE' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: 'SCHEMA_VALIDATION_FAILED' }, 400);
    if (error instanceof SyntaxError) return c.json({ error: 'INVALID_JSON' }, 400);
    if (error instanceof DomainError) return new Response(JSON.stringify({ error: error.code }), { status: error.status, headers: { 'content-type': 'application/json' } });
    // Error messages can contain source, SQL, tokens or remote responses.
    return c.json({ error: 'OPERATION_FAILED_INSPECT_RETAINED_STATE' }, 500);
  });
  app.get('/health/live', c => c.json({ status: 'alive', version: VERSION }));
  app.get('/health/compatibility', c => c.json({ product: 'embermend', version: VERSION, protocol: 1, magnusRequired: true, operatorSurface: 'hivexui', runtime: process.version, storage: 'postgresql', supportedTargets: ['ubuntu-24.04', 'github-typescript-javascript', 'docker-compose'] }));
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) return c.json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
    try { c.set('actor', await authenticate(header.slice(7))); } catch { return c.json({ error: 'IDENTITY_OR_PRODUCT_ACCESS_DENIED' }, 401); }
    await next();
  });
  app.get('/api/v1/readiness', async c => {
    const actor = c.get('actor'); requirePermission(actor, 'read', actor.scope);
    await service.db.$queryRaw`SELECT 1`;
    try {
      const all = await service.magnus.capabilities();
      const { within } = await import('@hivemagnus/embermend-store');
      const capabilities = { ...all, ...(all.agents ? { agents: all.agents.filter(agent => within(actor.scope, agent.scope)) } : {}), targets: all.targets.filter(target => within(actor.scope, target.scope)) };
      const eligibleTargets = capabilities.targets.filter(target => target.kind === 'target' && target.enrollment === 'enrolled' && target.lifecycle === 'active' && Date.now() - Date.parse(target.lastSeenAt) <= 120000 && Date.now() - Date.parse(target.lastSeenAt) >= -120000 && target.capabilities.includes('embermend:inventory.v1')).length;
      const assessmentReady = eligibleTargets > 0 && Date.now() - Date.parse(all.observedAt) <= 120000 && Date.now() - Date.parse(all.observedAt) >= -120000;
      return c.json({ status: assessmentReady ? 'ready' : 'degraded', serviceAvailable: true, assessmentReady, managedDispatch: assessmentReady, eligibleTargets, blockers: assessmentReady ? [] : ['NO_FRESH_ENROLLED_ASSESSMENT_TARGET'], capabilities });
    } catch { return c.json({ status: 'degraded', serviceAvailable: true, assessmentReady: false, managedDispatch: false, eligibleTargets: 0, blockers: ['MAGNUS_UNAVAILABLE_OR_INCOMPATIBLE'], capabilities: null }); }
  });
  app.get('/api/v1/entities', async c => c.json(await service.entities(c.get('actor'))));
  app.get('/api/v1/openapi.json', async c => { const actor = c.get('actor'); requirePermission(actor, 'read', actor.scope); return c.json(JSON.parse(await readFile(new URL('../../../packages/contracts/openapi.json', import.meta.url), 'utf8'))); });
  app.get('/api/v1/policies', async c => { const actor = c.get('actor'); requirePermission(actor, 'read', actor.scope); const { policySchema } = await import('@hivemagnus/embermend-contracts'); const { within } = await import('@hivemagnus/embermend-store'); return c.json((await service.db.policy.findMany({ where: { installationId: actor.scope.installationId } })).map(row => policySchema.parse(row.data)).filter(policy => within(actor.scope, policy.scope))); });
  app.get('/api/v1/access', c => { const actor = c.get('actor'); requirePermission(actor, 'read', actor.scope); return c.json({ actorId: actor.id, kind: actor.kind, permissions: [...actor.permissions], scope: actor.scope }); });
  app.post('/api/v1/entities', async c => c.json(await service.entity(c.get('actor'), await c.req.json()), 201));
  app.post('/api/v1/relationships', async c => c.json({ id: await service.records.relationship(c.get('actor'), await c.req.json()) }, 201));
  app.get('/api/v1/relationships', async c => c.json(await service.records.relationships(c.get('actor'))));
  app.post('/api/v1/observations', async c => c.json({ id: await service.records.observation(c.get('actor'), await c.req.json()) }, 201));
  app.post('/api/v1/profile-assignments', async c => c.json({ id: await service.records.assignment(c.get('actor'), await c.req.json()) }, 201));
  app.get('/api/v1/profile-assignments', async c => c.json(await service.records.assignments(c.get('actor'))));
  app.post('/api/v1/schedules', async c => c.json({ id: await service.records.schedule(c.get('actor'), await c.req.json()) }, 201));
  app.get('/api/v1/exceptions', async c => c.json(await service.records.exceptions(c.get('actor'))));
  app.get('/api/v1/campaigns/:id/report', async c => c.json(await service.records.campaignReport(c.get('actor'), c.req.param('id'))));
  app.get('/api/v1/findings', async c => c.json(await service.findings(c.get('actor'))));
  app.post('/api/v1/findings', async c => { const body = z.object({ finding: z.unknown(), occurrence: z.unknown() }).strict().parse(await c.req.json()); return c.json({ id: await service.finding(c.get('actor'), body.finding, body.occurrence) }, 201); });
  app.get('/api/v1/evidence/:id', async c => c.json(await service.readEvidence(c.get('actor'), c.req.param('id'))));
  app.post('/api/v1/evidence', async c => c.json({ id: await service.evidence(c.get('actor'), await c.req.json()) }, 201));
  app.post('/api/v1/profiles', async c => c.json({ id: await service.profile(c.get('actor'), await c.req.json()) }, 201));
  app.post('/api/v1/assessments', async c => c.json({ jobId: await service.assess(c.get('actor'), await c.req.json()) }, 202));
  app.post('/api/v1/vulnerability-assessments', async c => c.json({ jobId: await service.assessVulnerabilities(c.get('actor'), await c.req.json()) }, 202));
  app.post('/api/v1/scans', async c => c.json({ jobId: await service.scan(c.get('actor'), await c.req.json()) }, 202));
  app.post('/api/v1/preparations', async c => c.json({ jobId: await service.prepare(c.get('actor'), await c.req.json()) }, 202));
  app.post('/api/v1/source-reads', async c => c.json({ jobId: await service.source(c.get('actor'), await c.req.json()) }, 202));
  app.post('/api/v1/build-observations', async c => c.json({ jobId: await service.builds.request(c.get('actor'), await c.req.json()) }, 202));
  app.get('/api/v1/builds', async c => c.json(await service.builds.list(c.get('actor'))));
  app.get('/api/v1/jobs/:id', async c => c.json(await service.job(c.get('actor'), c.req.param('id'))));
  app.post('/api/v1/jobs/:id/reconcile', async c => c.json({ jobId: await service.reconcileJob(c.get('actor'), c.req.param('id')) }, 202));
  app.post('/api/v1/jobs/:id/cancel', async c => { await service.cancelJob(c.get('actor'), c.req.param('id')); return c.json({ cancellationRequested: true }); });
  app.get('/api/v1/recommendations', async c => c.json(await service.timeline(c.get('actor'))));
  // Hive:Magnus inbox feed, derived from committed audit rows with the recommendation read rules.
  app.get('/api/v1/hive/events', async c => {
    const actor = c.get('actor'); requirePermission(actor, 'read', actor.scope);
    let query: { after: string | undefined; limit: number };
    try { query = parseFeedQuery(new URL(c.req.url).searchParams); } catch { return c.json({ error: 'INVALID_FEED_QUERY' }, 400); }
    return c.json(await hiveEventFeed(service.db, actor, query));
  });
  // Suite audit export (HiveAuditRecord v1) for Cindertrace: every installation for a service holding
  // embermend:audit:read, the operator's own installation for an operator holding it.
  app.get('/api/v1/audit/export', async c => {
    const actor = c.get('actor'); auditExportInstallation(actor);
    let query: { after: string | undefined; limit: number };
    try { query = parseFeedQuery(new URL(c.req.url).searchParams, { defaultLimit: 100, maxLimit: 200 }); } catch { return c.json({ error: 'INVALID_FEED_QUERY' }, 400); }
    return c.json(await auditExport(service.db, actor, { ...query, ...(options.auditActorKind ? { actorKind: options.auditActorKind } : {}) }));
  });
  app.get('/api/v1/plans/:id', async c => c.json(await service.plan(c.get('actor'), c.req.param('id'))));
  app.post('/api/v1/plans', async c => c.json(await service.propose(c.get('actor'), await c.req.json()), 201));
  app.post('/api/v1/plans/:id/publish', async c => { const body = z.object({ revision: z.number().int().positive() }).strict().parse(await c.req.json()); return c.json({ publicationId: await service.publish(c.get('actor'), c.req.param('id'), body.revision) }); });
  app.post('/api/v1/decisions', async c => c.json({ decisionId: await service.decide(c.get('actor'), await c.req.json()) }));
  app.post('/api/v1/policies', async c => c.json({ id: await service.policy(c.get('actor'), await c.req.json()) }, 201));
  app.post('/api/v1/plans/:id/authorize-policy', async c => { const body = z.object({ policyId: z.string() }).strict().parse(await c.req.json()); return c.json({ authorizationId: await service.authorizePolicy(c.get('actor'), c.req.param('id'), body.policyId) }); });
  app.post('/api/v1/plans/:id/execute', async c => c.json({ jobId: await service.execute(c.get('actor'), c.req.param('id'), await c.req.json()) }, 202));
  app.post('/api/v1/campaigns/:id/pause', async c => { const body = z.object({ paused: z.boolean() }).strict().parse(await c.req.json()); await service.pause(c.get('actor'), c.req.param('id'), body.paused); return c.json({ paused: body.paused }); });
  app.get('/api/v1/operations/:id', async c => c.json(await service.reconcile(c.get('actor'), c.req.param('id'))));
  app.post('/api/v1/verifications', async c => c.json({ id: await service.verify(c.get('actor'), await c.req.json()) }, 201));
  app.post('/api/v1/exceptions', async c => c.json({ id: await service.exception(c.get('actor'), await c.req.json()) }, 201));
  app.get('/api/v1/export', async c => c.json({ generatedAt: new Date().toISOString(), entities: await service.entities(c.get('actor')), findings: await service.findings(c.get('actor')), campaigns: await service.timeline(c.get('actor')) }));
  return app;
}
