import type { z } from 'zod';
import type { Actor, Permission } from '@hivemagnus/embermend-contracts';
import { roleAuthority, type AccountLookup, type grantsSchema, type RoleScopes } from '@hivemagnus/embermend-integrations';
import { within } from '@hivemagnus/embermend-store';

/**
 * Jobs and schedules store the actor that created them. Before the worker acts on one,
 * that stored authority is checked against the identity grants (or, in Oathweave role mode,
 * the operator's Oathweave roles) in force now:
 * - no unique grant for the subject, a changed actor kind, or a stored scope the grant no
 *   longer covers revokes it (the job fails, the delivery is blocked);
 * - permissions are intersected with the grant, so a job continues only if it still has
 *   the permission its normal admission requires.
 */
export type Grants = z.infer<typeof grantsSchema>;
export type AuthorityDecision =
  | { allowed: true; actor: Actor; removed: Permission[] }
  | { allowed: false; reason: 'ACTOR_GRANT_REVOKED' | 'ACTOR_KIND_CHANGED' | 'ACTOR_SCOPE_REVOKED' };
/**
 * May be asynchronous. It throws (an `identity_unavailable` OathweaveError) only when the
 * current authority cannot be read; the worker then retries instead of revoking anything.
 */
export type StoredAuthority = (stored: Actor) => AuthorityDecision | Promise<AuthorityDecision>;
/** A stored-authority check that answers at once, from grants held in memory. */
export type GrantCheck = (stored: Actor) => AuthorityDecision;

export const REVOKED_AUTHORITY_CODES: readonly string[] = ['ACTOR_GRANT_REVOKED', 'ACTOR_KIND_CHANGED', 'ACTOR_SCOPE_REVOKED'];

/** Check stored authority against `grants`, or against what a grant source returns at each check. */
export function grantAuthority(grants: Grants | (() => Grants)): GrantCheck {
  const current = typeof grants === 'function' ? grants : (): Grants => grants;
  return stored => {
    const matching = current().filter(grant => grant.subject === stored.id);
    const grant = matching.length === 1 ? matching[0] : undefined;
    if (!grant) return { allowed: false, reason: 'ACTOR_GRANT_REVOKED' };
    return intersect(stored, grant);
  };
}

function intersect(stored: Actor, current: Pick<Grants[number], 'kind' | 'scope' | 'permissions'>): AuthorityDecision {
  if (current.kind !== stored.kind) return { allowed: false, reason: 'ACTOR_KIND_CHANGED' };
  if (!within(current.scope, stored.scope)) return { allowed: false, reason: 'ACTOR_SCOPE_REVOKED' };
  const granted = new Set<Permission>(current.permissions);
  const kept = [...stored.permissions].filter(permission => granted.has(permission));
  const removed = [...stored.permissions].filter(permission => !granted.has(permission));
  return { allowed: true, actor: { ...stored, permissions: new Set(kept) }, removed };
}

/**
 * With `EMBERMEND_AUTHORITY_SOURCE=oathweave`: a stored operator is checked against its current
 * Oathweave account and roles (see oathweave-roles.ts in the integrations package). A missing or
 * disabled account, or no mapped role left, revokes it (`ACTOR_GRANT_REVOKED`); a scope its
 * roles no longer cover is `ACTOR_SCOPE_REVOKED`; permissions are intersected with the
 * `embermend:*` permissions its roles still carry. Coordinators and integrations are checked
 * against the service grants as before.
 */
export function oathweaveRoleAuthority(lookup: AccountLookup, scopes: () => RoleScopes, serviceGrants: Grants | (() => Grants)): StoredAuthority {
  const services = grantAuthority(serviceGrants);
  return async stored => {
    if (stored.kind !== 'operator') return services(stored);
    const derived = roleAuthority(await lookup(stored.id), scopes());
    if (!derived.ok) return { allowed: false, reason: 'ACTOR_GRANT_REVOKED' };
    return intersect(stored, { kind: 'operator', scope: derived.scope, permissions: derived.permissions });
  };
}

/** Accept stored authority as recorded. Only for tests that exercise one worker tick. */
export const unverifiedStoredAuthority: StoredAuthority = stored => ({ allowed: true, actor: stored, removed: [] });
