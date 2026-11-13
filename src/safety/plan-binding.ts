/**
 * Binding an apply to the change that was reviewed. A preview carries a digest of what it showed; the
 * apply must present that digest, and the deployment must still be the one that was reviewed. Pure
 * functions (no I/O). Secret values never enter a digest: it is built from the already-redacted preview.
 */

import { createHash } from 'node:crypto';
import type { CH2Deployment } from '../api/CloudHub2Api.js';

/** JSON with object keys sorted at every level, so equal data always serializes the same way. */
export function canonicalJson(value: unknown): string {
    const sorted = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sorted);
        if (v && typeof v === 'object') {
            return Object.fromEntries(
                Object.entries(v as Record<string, unknown>)
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([k, x]) => [k, sorted(x)]),
            );
        }
        return v;
    };
    return JSON.stringify(sorted(value));
}

export function digestOf(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * The refusal text for an apply that does not carry the digest of its preview, or carries one for a
 * different change; `null` when it matches.
 */
export function checkReviewedPlan(presented: string | undefined, current: string): string | null {
    if (!presented) {
        return 'planDigest is required with confirm: true. Call without confirm, review the preview, then pass its planDigest. Nothing was changed.';
    }
    if (presented !== current) {
        return 'The change now differs from the one you reviewed (the application or the request changed). Nothing was changed. Preview again and pass the new planDigest.';
    }
    return null;
}

/** The parts of a deployment that decide what a change would do, for when revision fields are absent. */
function stateOf(d: CH2Deployment) {
    return { application: d.application, target: d.target };
}

/**
 * Refuse to write when the deployment is no longer the one that was reviewed: recreated (new id) or
 * changed. Compares the revision fields the platform sets; when neither is present on the reviewed
 * deployment it compares the state itself, because silence is not proof that nothing changed.
 */
export function assertDeploymentUnchanged(reviewed: CH2Deployment, current: CH2Deployment): void {
    const changed = (what: string) =>
        new Error(`The deployment changed after review (${what}). Nothing was changed; prepare the change again.`);
    if (reviewed.id !== current.id) throw changed('it was recreated');
    const hasRevision = reviewed.desiredVersion !== undefined || reviewed.lastModifiedDate !== undefined;
    if (hasRevision) {
        if (reviewed.desiredVersion !== current.desiredVersion) throw changed('a new revision was applied');
        if (reviewed.lastModifiedDate !== current.lastModifiedDate) throw changed('it was modified');
        return;
    }
    if (canonicalJson(stateOf(reviewed)) !== canonicalJson(stateOf(current))) throw changed('its state differs');
}
