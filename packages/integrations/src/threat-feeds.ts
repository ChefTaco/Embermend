import { z } from 'zod';
import { responseJson } from './index.js';

const cve = z.string().regex(/^CVE-\d{4}-\d{4,}$/);
const kevSchema = z.object({ catalogVersion: z.string(), dateReleased: z.iso.datetime({ offset: true }), vulnerabilities: z.array(z.object({ cveID: cve, dateAdded: z.iso.date() })) });
const epssSchema = z.object({ status: z.literal('OK'), data: z.array(z.object({ cve, epss: z.coerce.number().min(0).max(1), percentile: z.coerce.number().min(0).max(1), date: z.iso.date() })) });
export { threatSignalsSchema, type ThreatSignals } from '@hivemagnus/embermend-contracts';
import { type ThreatSignals } from '@hivemagnus/embermend-contracts';
export function normalizeThreatSignals(cves: readonly string[], rawKev: unknown, rawEpss: unknown, now = new Date()): ThreatSignals[] {
  const kev = kevSchema.safeParse(rawKev); const epss = epssSchema.safeParse(rawEpss);
  return [...new Set(cves.map(value => cve.parse(value)))].map(id => {
    const catalog = kev.success ? kev.data : null; const entry = catalog?.vulnerabilities.find(row => row.cveID === id);
    const forecast = epss.success ? epss.data.data.find(row => row.cve === id) : null;
    const failures = [...(!catalog ? ['KEV_UNAVAILABLE_OR_INVALID'] : []), ...(!forecast ? ['EPSS_UNAVAILABLE_OR_NO_CVE_SCORE'] : [])];
    return { cve: id, kev: catalog ? { listed: Boolean(entry), catalogVersion: catalog.catalogVersion, publishedAt: catalog.dateReleased, addedOn: entry?.dateAdded ?? null, stale: now.getTime() - Date.parse(catalog.dateReleased) > 7 * 86400000 || Date.parse(catalog.dateReleased) > now.getTime() + 120000 } : null, epss: forecast ? { score: forecast.epss, percentile: forecast.percentile, date: forecast.date, stale: now.getTime() - Date.parse(forecast.date) > 3 * 86400000 || Date.parse(forecast.date) > now.getTime() + 86400000, meaning: 'CVE exploitation forecast; not an asset compromise probability' } : null, failures };
  });
}
/** Public feed access never receives product or provider credentials. Unavailable
 * data remains unknown and cannot lower priority or establish a clean result. */
export async function threatSignals(cves: readonly string[], signal?: AbortSignal): Promise<ThreatSignals[]> {
  if (!cves.length) return [];
  const ids = [...new Set(cves.map(value => cve.parse(value)))]; if (ids.length > 100) throw new Error('Threat enrichment batch exceeds 100 CVEs');
  const timeout = AbortSignal.timeout(15000); const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const get = async (url: string): Promise<unknown> => { try { const response = await fetch(url, { redirect: 'error', signal: bounded }); return response.ok ? await responseJson(response) : null; } catch { return null; } };
  const results = await Promise.allSettled([get('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'), get('https://api.first.org/data/v1/epss?cve=' + ids.map(encodeURIComponent).join(','))]);
  const kev = results[0]?.status === 'fulfilled' ? results[0].value : null; const epss = results[1]?.status === 'fulfilled' ? results[1].value : null;
  return normalizeThreatSignals(ids, kev, epss);
}
