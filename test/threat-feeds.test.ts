import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThreatSignals } from '@hivemagnus/embermend-integrations';
test('unavailable threat feeds remain unknown rather than negative evidence', () => {
  const [result] = normalizeThreatSignals(['CVE-2026-12345'], null, null);
  assert.ok(result); assert.equal(result.kev, null); assert.equal(result.epss, null); assert.equal(result.failures.length, 2);
});
test('dated KEV and EPSS evidence preserves its meaning and staleness', () => {
  const kev = { catalogVersion: '2026.11.10', dateReleased: '2026-11-10T00:00:00Z', vulnerabilities: [{ cveID: 'CVE-2026-12345', dateAdded: '2026-11-09' }] };
  const epss = { status: 'OK', data: [{ cve: 'CVE-2026-12345', epss: '0.41', percentile: '0.98', date: '2026-11-09' }] };
  const [result] = normalizeThreatSignals(['CVE-2026-12345'], kev, epss, new Date('2026-11-10T01:00:00Z'));
  assert.ok(result?.epss); assert.equal(result.kev?.listed, true); assert.equal(result.epss.score, 0.41); assert.match(result.epss.meaning, /not an asset/); assert.equal(result.epss.stale, false);
  const [stale] = normalizeThreatSignals(['CVE-2026-12345'], kev, epss, new Date('2026-12-10T01:00:00Z')); assert.equal(stale?.kev?.stale, true); assert.equal(stale?.epss?.stale, true);
});
