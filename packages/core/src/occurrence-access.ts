import { entitySchema, evidenceSchema, type Actor, type Occurrence, type Scope } from '@hivemagnus/embermend-contracts';
import { within, type Database } from '@hivemagnus/embermend-store';

const BATCH = 1000;
async function scopes(ids: readonly string[], load: (batch: string[]) => Promise<Array<[string, Scope]>>): Promise<Map<string, Scope>> {
  const unique = [...new Set(ids)]; const result = new Map<string, Scope>();
  for (let index = 0; index < unique.length; index += BATCH) for (const [id, scope] of await load(unique.slice(index, index + BATCH))) result.set(id, scope);
  return result;
}

/**
 * Application-wide findings do not grant access to every host occurrence. Subjects and evidence
 * are read in batches, not once per occurrence.
 */
export async function visibleOccurrences(db: Database, actor: Actor, occurrences: readonly Occurrence[]): Promise<Occurrence[]> {
  const subjects = await scopes(occurrences.map(occurrence => occurrence.subjectId), async batch => (await db.entity.findMany({ where: { id: { in: batch } } })).map(row => [row.id, entitySchema.parse(row.data).scope]));
  // Legacy observations can precede subject reconciliation. In that case
  // require readable evidence rather than inferring access from the finding.
  const evidence = await scopes(occurrences.filter(occurrence => !subjects.has(occurrence.subjectId)).flatMap(occurrence => occurrence.evidenceIds), async batch => (await db.evidence.findMany({ where: { id: { in: batch } } })).map(row => [row.id, evidenceSchema.parse(row.data).scope]));
  return occurrences.filter(occurrence => {
    const subject = subjects.get(occurrence.subjectId);
    if (subject) return within(actor.scope, subject);
    return occurrence.evidenceIds.length > 0 && occurrence.evidenceIds.every(id => { const scope = evidence.get(id); return scope !== undefined && within(actor.scope, scope); });
  });
}
