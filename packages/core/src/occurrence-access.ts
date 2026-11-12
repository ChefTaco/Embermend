import { entitySchema, evidenceSchema, type Actor, type Occurrence } from '@hivemagnus/embermend-contracts';
import { within, type Database } from '@hivemagnus/embermend-store';

/** Application-wide findings do not grant access to every host occurrence. */
export async function visibleOccurrences(db: Database, actor: Actor, occurrences: readonly Occurrence[]): Promise<Occurrence[]> {
  const result: Occurrence[] = [];
  for (const occurrence of occurrences) {
    const subject = await db.entity.findUnique({ where: { id: occurrence.subjectId } });
    if (subject) {
      if (within(actor.scope, entitySchema.parse(subject.data).scope)) result.push(occurrence);
      continue;
    }
    // Legacy observations can precede subject reconciliation. In that case
    // require readable evidence rather than inferring access from the finding.
    let readable = occurrence.evidenceIds.length > 0;
    for (const id of occurrence.evidenceIds) {
      const row = await db.evidence.findUnique({ where: { id } });
      if (!row || !within(actor.scope, evidenceSchema.parse(row.data).scope)) { readable = false; break; }
    }
    if (readable) result.push(occurrence);
  }
  return result;
}
