/**
 * Audit log actor classification
 * Tells platform-initiated audit entries (staff patches, replica moves, infrastructure patches)
 * apart from changes made by a user or a pipeline, so "who changed this app?" is not answered with
 * a platform maintenance event. Every rule lives in ACTOR_RULES; the first match wins.
 *
 * Every platform-* class requires a recognized platform identity: a staff or service user name, or
 * the platform patcher's client name. An entry with no user and an unrecognized client (a connected
 * app, a pipeline) stays user-or-pipeline. There is no caller-supplied override: a client ID alone
 * never makes an entry "platform".
 */

import type { AuditLogEntry } from '../api/AuditLogApi.js';

export const ACTOR_CLASSES = [
    'platform-patch',
    'platform-replica',
    'platform-infrastructure',
    'user-or-pipeline',
] as const;
export type ActorClass = (typeof ACTOR_CLASSES)[number];

export interface ActorRule {
    id: string;
    actorClass: Exclude<ActorClass, 'user-or-pipeline'>;
    description: string;
    matches(entry: AuditLogEntry): boolean;
}

/** User names the platform uses for its own staff and service identities. */
const PLATFORM_USER = /\b(anypoint|mulesoft|cloudhub|platform)\s+(staff|support|operations|ops|system|automation)\b/i;
/** Client names of the platform's automatic patcher. */
const PATCHER_CLIENT = /\b(auto(matic)?[\s_-]?patch(er|ing)?|patch(ing)?[\s_-]?(service|automation|bot))\b/i;
const MODIFY_ACTION = /^(modify|update|patch)$/i;
const REPLICA = /\breplicas?\b/i;
/** Whole words only, so "Remove" is not "move". */
const REPLICA_MOVE =
    /\b(restart(ed)?|move[ds]?|relocated?|rescheduled?|migrated?|evicted?|recreated?|replaced?|recovered?)\b/i;
const INFRA_PATCH_ACTION = /^patch\s*(fabric|network)\b/i;
const PATCH_ACTION = /\bpatch(ed)?\b/i;
const INFRA_OBJECT = /\b(fabric|network)\b/i;

function objectTypes(entry: AuditLogEntry): string[] {
    return (entry.objects ?? []).map((o) => o.objectType ?? '');
}

/** Whether the actor is a recognized platform staff or service identity. */
export function isPlatformIdentity(entry: AuditLogEntry): boolean {
    if (entry.userName && PLATFORM_USER.test(entry.userName)) return true;
    return Boolean(entry.clientName && PATCHER_CLIENT.test(entry.clientName));
}

/** The matching rules, in order. Keep every classification decision here. */
export const ACTOR_RULES: readonly ActorRule[] = [
    {
        id: 'infrastructure-patch-action',
        actorClass: 'platform-infrastructure',
        description: 'Patch Fabric or Patch Network by a platform identity',
        matches: (entry) => INFRA_PATCH_ACTION.test(entry.action) && isPlatformIdentity(entry),
    },
    {
        id: 'infrastructure-patch-object',
        actorClass: 'platform-infrastructure',
        description: 'A patch action on a fabric or network object by a platform identity',
        matches: (entry) =>
            PATCH_ACTION.test(entry.action) &&
            objectTypes(entry).some((t) => INFRA_OBJECT.test(t)) &&
            isPlatformIdentity(entry),
    },
    {
        id: 'replica-restarted-or-moved',
        actorClass: 'platform-replica',
        description: 'A replica restarted, moved or rescheduled by a platform identity',
        matches: (entry) =>
            (REPLICA.test(entry.action) || objectTypes(entry).some((t) => REPLICA.test(t))) &&
            REPLICA_MOVE.test(entry.action) &&
            isPlatformIdentity(entry),
    },
    {
        id: 'platform-modify-application',
        actorClass: 'platform-patch',
        description: 'Modify on an Application by a platform staff or patcher identity',
        matches: (entry) =>
            MODIFY_ACTION.test(entry.action) &&
            objectTypes(entry).some((t) => /^application$/i.test(t)) &&
            isPlatformIdentity(entry),
    },
    {
        id: 'platform-identity',
        actorClass: 'platform-patch',
        description: 'Any other action by a platform staff or patcher identity',
        matches: (entry) => isPlatformIdentity(entry),
    },
];

export interface ActorClassification {
    actorClass: ActorClass;
    /** The rule that matched, or "default" for user-or-pipeline. */
    actorRule: string;
}

export function classifyAuditActor(entry: AuditLogEntry): ActorClassification {
    const rule = ACTOR_RULES.find((r) => r.matches(entry));
    return rule
        ? { actorClass: rule.actorClass, actorRule: rule.id }
        : { actorClass: 'user-or-pipeline', actorRule: 'default' };
}

/** Classify entries and count them by class (every class present, zeros included). */
export function classifyAuditEntries(entries: AuditLogEntry[]): {
    entries: Array<AuditLogEntry & ActorClassification>;
    byClass: Record<ActorClass, number>;
} {
    const byClass = Object.fromEntries(ACTOR_CLASSES.map((c) => [c, 0])) as Record<ActorClass, number>;
    const classified = entries.map((entry) => {
        const result = classifyAuditActor(entry);
        byClass[result.actorClass]++;
        return { ...entry, ...result };
    });
    return { entries: classified, byClass };
}
