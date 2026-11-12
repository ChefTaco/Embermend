import { z } from 'zod';
import { vulnerabilityAssessmentSchema, type Actor, type Finding, type Coverage } from '@hivemagnus/embermend-contracts';
import { digest } from '@hivemagnus/embermend-store';
import { threatSignals } from '@hivemagnus/embermend-integrations';
import type { Embermend } from '@hivemagnus/embermend-core';

const packageSchema = z.object({ name: z.string(), installedVersion: z.string(), architecture: z.string(), fixedVersions: z.array(z.string()) }).strict();
const assessmentSchema = z.object({ engine: z.string(), engineVersion: z.string(), vendor: z.string(), platform: z.string(), observedAt: z.iso.datetime({ offset: true }), coverage: z.enum(['complete', 'partial', 'stale']), failures: z.array(z.string()), feed: z.object({ url: z.url(), generatedAt: z.iso.datetime({ offset: true }), sha256: z.string().regex(/^[a-f0-9]{64}$/) }), advisories: z.array(z.object({ definitionId: z.string(), title: z.string(), severity: z.string(), references: z.array(z.object({ source: z.string(), id: z.string(), url: z.string() })), cves: z.array(z.string().regex(/^CVE-\d{4}-\d{4,}$/)), packages: z.array(packageSchema), vendorDecision: z.literal('affected') })), definitionCount: z.number().int(), resultSha256: z.string().regex(/^[a-f0-9]{64}$/) });
export async function ingestVulnerabilities(service: Embermend, actor: Actor, request: z.infer<typeof vulnerabilityAssessmentSchema>, raw: Record<string, unknown>, operationId: string) {
  const result = assessmentSchema.parse(request.kind === 'ubuntu' ? raw['ubuntuOval'] : raw['imageVulnerabilities']);
  const subject = request.targetId; const scope = { ...request.scope, targetIds: [subject] }; const evidenceId = digest(['vulnerability-evidence', operationId]);
  await service.evidence(actor, { id: evidenceId, scope, subjectId: subject, method: request.kind === 'ubuntu' ? 'ubuntu-oval.v1' : 'image-vulnerabilities.v1', observedAt: result.observedAt, digest: digest(result), content: result, sensitivity: 'ordinary', source: 'magnus' });
  const cves = [...new Set(result.advisories.flatMap(item => item.cves))]; const signals = [];
  for (let index = 0; index < cves.length; index += 100) signals.push(...await threatSignals(cves.slice(index, index + 100)));
  const coverage: Coverage = { status: result.coverage, requested: [subject], examined: [subject], excluded: [], failures: result.failures.slice(0, 100), mode: 'full', observedAt: result.observedAt };
  let count = 0;
  for (const advisory of result.advisories) for (const pkg of advisory.packages) {
    const identity = digest([request.kind, subject, advisory.definitionId, pkg.name, pkg.architecture]);
    const selected = signals.filter(item => advisory.cves.includes(item.cve));
    const severity = severityOf(advisory.severity);
    // Enrichment can raise an assessment priority. Missing or stale threat feeds
    // cannot turn a vendor finding into a negative decision.
    const base = severity === 'critical' ? 85 : severity === 'high' ? 70 : severity === 'medium' ? 45 : 25;
    const priority = Math.min(100, base + (selected.some(item => item.kev?.listed && !item.kev.stale) ? 10 : 0) + (selected.some(item => item.epss && !item.epss.stale && item.epss.score >= 0.1) ? 5 : 0));
    const finding: Finding = { id: identity, identity, scope, kind: request.kind === 'ubuntu' ? 'os-package' : 'image', component: subject, weakness: advisory.definitionId, title: advisory.title, severity, confidence: 1, validity: 'validated', rationale: 'Vendor applicability evaluated by the recorded engine against the observed package. Coverage and feed freshness remain separate from validity.', evidenceIds: [evidenceId], classifications: advisory.cves, priority, vulnerability: { advisoryId: advisory.definitionId, cves: advisory.cves, packageName: pkg.name, installedVersion: pkg.installedVersion, fixedVersions: pkg.fixedVersions, vendor: result.vendor, feedDigest: result.feed.sha256, feedGeneratedAt: result.feed.generatedAt, engineVersion: result.engineVersion, vendorDecision: 'affected', signals: selected } };
    await service.finding(actor, finding, { id: digest([identity, request.imageRef]), findingId: identity, subjectId: subject, branch: null, revision: null, artifactDigest: request.imageRef?.split('@sha256:')[1] ?? null, sourceState: 'not-applicable', runtimeState: 'affected', coverage, evidenceIds: [evidenceId], recurrenceOf: null }); count++;
  }
  return { evidenceId, count, coverage, enrichmentFailures: signals.filter(item => item.failures.length).length };
}
function severityOf(input: string): Finding['severity'] {
  switch (input.toLowerCase()) { case 'critical': return 'critical'; case 'high': return 'high'; case 'medium': case 'moderate': return 'medium'; case 'low': case 'negligible': return 'low'; default: return 'unknown'; }
}
