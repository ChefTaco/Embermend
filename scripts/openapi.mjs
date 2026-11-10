import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as c from '../packages/contracts/dist/index.js';
const source = await readFile(new URL('../services/runtime/src/api.ts', import.meta.url), 'utf8');
const findings = z.array(z.object({ finding: c.findingSchema, occurrences: z.array(c.occurrenceSchema) }));
const idResult = z.object({ id: c.id });
const jobResult = z.object({ jobId: c.id });
const requests = new Map([
  ['/entities', c.entitySchema], ['/evidence', c.evidenceSchema], ['/findings', z.object({ finding: c.findingSchema, occurrence: c.occurrenceSchema }).strict()], ['/plans', c.planSchema], ['/policies', c.policySchema], ['/decisions', c.decisionSchema], ['/verifications', c.verificationSchema], ['/exceptions', c.exceptionSchema], ['/scans', c.scanRequestSchema], ['/assessments', c.assessmentRequestSchema], ['/vulnerability-assessments', c.vulnerabilityAssessmentSchema], ['/profiles', c.profileSchema], ['/preparations', c.preparationSchema], ['/source-reads', c.sourceRequestSchema], ['/relationships', c.relationshipSchema], ['/observations', c.observationSchema], ['/profile-assignments', c.profileAssignmentSchema], ['/schedules', c.scheduleSchema], ['/plans/:id/execute', z.object({ revision: z.number().int().positive(), digest: c.sha256 }).strict()], ['/plans/:id/publish', z.object({ revision: z.number().int().positive() }).strict()], ['/plans/:id/authorize-policy', z.object({ policyId: c.id }).strict()], ['/campaigns/:id/pause', z.object({ paused: z.boolean() }).strict()],
]);
const reports = z.object({ reportId: c.id, generatedAt: c.timestamp, campaign: c.recommendationSchema.shape.campaign.unwrap(), plans: z.array(z.object({ plan: c.planSchema, digest: c.sha256, status: c.id, publications: c.recommendationSchema.shape.publications, executions: z.array(z.object({ id: c.id, revision: z.number().int(), actionId: c.id, state: c.id, receipt: c.receiptSchema.nullable() })), findings: z.array(z.object({ finding: c.findingSchema, occurrences: z.array(c.occurrenceSchema), verifications: z.array(c.verificationSchema) })) })), exceptions: z.array(c.exceptionSchema) });
const getResponses = new Map([
  ['/entities', z.array(c.entitySchema)], ['/findings', findings], ['/evidence/:id', c.evidenceSchema], ['/recommendations', z.array(c.recommendationSchema)], ['/plans/:id', c.planSchema], ['/jobs/:id', c.jobSchema], ['/operations/:id', c.receiptSchema], ['/access', c.accessSchema], ['/relationships', z.array(c.relationshipSchema)], ['/profile-assignments', z.array(c.profileAssignmentSchema)], ['/exceptions', z.array(c.exceptionSchema)], ['/policies', z.array(c.policySchema)], ['/campaigns/:id/report', reports], ['/export', z.object({ generatedAt: c.timestamp, entities: z.array(c.entitySchema), findings, campaigns: z.array(c.recommendationSchema) })], ['/readiness', c.readinessSchema], ['/openapi.json', z.record(z.string(), z.json())],
]);
const accepted = new Set(['/assessments', '/vulnerability-assessments', '/scans', '/preparations', '/source-reads', '/plans/:id/execute', '/jobs/:id/reconcile']);
const created = new Set(['/entities', '/evidence', '/findings', '/plans', '/policies', '/profiles', '/verifications', '/exceptions', '/relationships', '/observations', '/profile-assignments', '/schedules']);
const postResponses = new Map([
  ['/entities', c.entitySchema], ['/plans', z.object({ id: c.id, revision: z.number().int(), digest: c.sha256 })], ['/plans/:id/execute', z.object({ revision: z.number().int().positive(), digest: c.sha256 }).strict()], ['/plans/:id/publish', z.object({ publicationId: c.id })], ['/plans/:id/authorize-policy', z.object({ authorizationId: c.id })], ['/decisions', z.object({ decisionId: c.id })], ['/jobs/:id/cancel', z.object({ cancellationRequested: z.literal(true) })], ['/campaigns/:id/pause', z.object({ paused: z.boolean() })],
]);
const schema = value => z.toJSONSchema(value, { target: 'draft-2020-12' });
const paths = {};
for (const match of source.matchAll(/app\.(get|post)\('([^']+)'/g)) {
  const [, method, native] = match; const path = native.replace(/:([a-zA-Z]+)/g, '{$1}'); const short = native.replace(/^\/api\/v1/, '');
  const body = method === 'post' ? requests.get(short) : undefined;
  const response = native === '/health/live' ? z.object({ status: z.literal('alive'), version: c.id }) : native === '/health/compatibility' ? c.compatibilitySchema : method === 'get' ? getResponses.get(short) : postResponses.get(short) ?? (accepted.has(short) ? jobResult : created.has(short) ? idResult : undefined);
  if (!response) throw new Error(`Missing response contract: ${method} ${native}`);
  paths[path] ??= {};
  const status = method === 'post' && accepted.has(short) ? '202' : method === 'post' && created.has(short) ? '201' : '200';
  paths[path][method] = { operationId: method + native.replace(/[^a-zA-Z0-9]/g, '_'), ...(native.startsWith('/api/') ? { security: [{ bearerAuth: [] }] } : {}), parameters: [...native.matchAll(/:([a-zA-Z]+)/g)].map(value => ({ name: value[1], in: 'path', required: true, schema: { type: 'string' } })), ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(body) } } } } : {}), responses: { [status]: { description: status === '202' ? 'Durable job accepted; inspect its original identity for progress and cancellation' : 'Authoritative scoped result', content: { 'application/json': { schema: schema(response) } } }, '400': { description: 'Invalid schema' }, '401': { description: 'Authentication required' }, '403': { description: 'Scope or permission denied' }, '409': { description: 'Changed preconditions or retained execution requires reconciliation' } } };
}
const document = { openapi: '3.1.0', info: { title: 'Embermend API', version: c.VERSION }, servers: [{ url: '/' }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, paths };
const output = JSON.stringify(document, null, 2) + '\n'; const file = new URL('../packages/contracts/openapi.json', import.meta.url);
if (process.argv.includes('--write')) await writeFile(file, output);
else if (await readFile(file, 'utf8') !== output) throw new Error('OpenAPI is stale; run npm run openapi:write');
console.log('Every registered route has a generated request/status/response contract.');
