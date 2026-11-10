import type { Finding } from '@hivemagnus/embermend-contracts';
export function prioritize(finding: Finding, firstSeenAt: string, importance: NonNullable<Finding['risk']>['importance'], now = new Date()): Pick<Finding, 'priority' | 'risk'> {
  const exposure = finding.risk?.exposure ?? 'unknown';
  const fixAvailability = finding.vulnerability ? finding.vulnerability.fixedVersions.length ? 'available' : 'unavailable' : finding.risk?.fixAvailability ?? 'unknown';
  const severityPoints = finding.severity === 'critical' ? 70 : finding.severity === 'high' ? 55 : finding.severity === 'medium' ? 35 : finding.severity === 'low' ? 15 : 30;
  const age = Math.max(0, now.getTime() - Date.parse(firstSeenAt));
  const factors = [{ reason: `severity:${finding.severity}`, points: severityPoints }, { reason: `exposure:${exposure}`, points: exposure === 'internet' ? 12 : exposure === 'internal' ? 4 : exposure === 'unknown' ? 4 : 0 }, { reason: `importance:${importance}`, points: importance === 'critical' ? 10 : importance === 'high' ? 5 : 0 }, { reason: 'age-of-outstanding-finding', points: age > 30 * 86400000 ? 5 : age > 7 * 86400000 ? 2 : 0 }, { reason: `fix:${fixAvailability}`, points: fixAvailability === 'available' ? 3 : 0 }];
  const signals = finding.vulnerability?.signals ?? [];
  if (signals.some(item => item.kev?.listed && !item.kev.stale)) factors.push({ reason: 'dated-KEV-exploitation-evidence', points: 15 });
  if (signals.some(item => item.epss && !item.epss.stale && item.epss.score >= 0.1)) factors.push({ reason: 'dated-EPSS-CVE-forecast', points: signals.some(item => item.epss && !item.epss.stale && item.epss.score >= 0.5) ? 8 : 5 });
  return { priority: Math.min(100, factors.reduce((sum, item) => sum + item.points, 0)), risk: { exposure, importance, firstSeenAt, fixAvailability, factors, evidenceIds: finding.risk?.evidenceIds ?? [] } };
}
