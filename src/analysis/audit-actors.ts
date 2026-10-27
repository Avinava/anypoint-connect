/**
 * Audit log actor classification
 * Tells platform-initiated audit entries (staff patches, replica moves, infrastructure patches)
 * apart from changes made by a user or a pipeline, so "who changed this app?" is not answered with
 * a platform maintenance event. Every rule lives in ACTOR_RULES; the first match wins.
 */

import type { AuditLogEntry } from '../api/AuditLogApi.js';

export const ACTOR_CLASSES = [
    'platform-patch',
    'platform-replica',
    'platform-infrastructure',
    'user-or-pipeline',
] as const;
export type ActorClass = (typeof ACTOR_CLASSES)[number];

export interface ActorContext {
    /** Client IDs known to belong to the platform's automatic patcher in this organization. */
    platformClientIds?: string[];
}

export interface ActorRule {
    id: string;
    actorClass: Exclude<ActorClass, 'user-or-pipeline'>;
    description: string;
    matches(entry: AuditLogEntry, context: ActorContext): boolean;
}

/** User names the platform uses for its own staff and service identities. */
const PLATFORM_USER = /\b(anypoint|mulesoft|cloudhub|platform)\s+(staff|support|operations|ops|system|automation)\b/i;
/** Client names of the platform's automatic patcher. */
const PATCHER_CLIENT = /\b(auto(matic)?[\s_-]?patch(er|ing)?|patch(ing)?[\s_-]?(service|automation|bot))\b/i;
const MODIFY_ACTION = /^(modify|update|patch)$/i;
const REPLICA = /replica/i;
const REPLICA_MOVE = /restart|move|relocat|reschedul|migrat|evict|recreat|replac|recover/i;
const INFRA_PATCH_ACTION = /^patch\s*(fabric|network)\b/i;
const INFRA_OBJECT = /fabric|network/i;

function objectTypes(entry: AuditLogEntry): string[] {
    return (entry.objects ?? []).map((o) => o.objectType ?? '');
}

/** Whether the actor is a platform staff or service identity rather than an organization user or client. */
export function isPlatformIdentity(entry: AuditLogEntry, context: ActorContext = {}): boolean {
    if (entry.userName && PLATFORM_USER.test(entry.userName)) return true;
    if (entry.clientName && PATCHER_CLIENT.test(entry.clientName)) return true;
    return Boolean(entry.clientId && context.platformClientIds?.includes(entry.clientId));
}

/** The matching rules, in order. Keep every classification decision here. */
export const ACTOR_RULES: readonly ActorRule[] = [
    {
        id: 'infrastructure-patch-action',
        actorClass: 'platform-infrastructure',
        description: 'Action is Patch Fabric or Patch Network',
        matches: (entry) => INFRA_PATCH_ACTION.test(entry.action),
    },
    {
        id: 'infrastructure-patch-object',
        actorClass: 'platform-infrastructure',
        description: 'A patch action on a fabric or network object',
        matches: (entry) => /patch/i.test(entry.action) && objectTypes(entry).some((t) => INFRA_OBJECT.test(t)),
    },
    {
        id: 'replica-restarted-or-moved',
        actorClass: 'platform-replica',
        description:
            'A replica restarted, moved or rescheduled by the platform (replica action or object, no organization user)',
        matches: (entry, context) =>
            (REPLICA.test(entry.action) || objectTypes(entry).some((t) => REPLICA.test(t))) &&
            REPLICA_MOVE.test(entry.action) &&
            (!entry.userName || isPlatformIdentity(entry, context)),
    },
    {
        id: 'platform-modify-application',
        actorClass: 'platform-patch',
        description:
            'Modify on an Application by a platform staff or service identity (staff user name, patcher client name, or a platformClientIds entry)',
        matches: (entry, context) =>
            MODIFY_ACTION.test(entry.action) &&
            objectTypes(entry).some((t) => /^application$/i.test(t)) &&
            isPlatformIdentity(entry, context),
    },
    {
        id: 'platform-identity',
        actorClass: 'platform-patch',
        description: 'Any other action by a platform staff or service identity',
        matches: (entry, context) => isPlatformIdentity(entry, context),
    },
];

export interface ActorClassification {
    actorClass: ActorClass;
    /** The rule that matched, or "default" for user-or-pipeline. */
    actorRule: string;
}

export function classifyAuditActor(entry: AuditLogEntry, context: ActorContext = {}): ActorClassification {
    const rule = ACTOR_RULES.find((r) => r.matches(entry, context));
    return rule
        ? { actorClass: rule.actorClass, actorRule: rule.id }
        : { actorClass: 'user-or-pipeline', actorRule: 'default' };
}

/** Classify entries and count them by class (every class present, zeros included). */
export function classifyAuditEntries(
    entries: AuditLogEntry[],
    context: ActorContext = {},
): { entries: Array<AuditLogEntry & ActorClassification>; byClass: Record<ActorClass, number> } {
    const byClass = Object.fromEntries(ACTOR_CLASSES.map((c) => [c, 0])) as Record<ActorClass, number>;
    const classified = entries.map((entry) => {
        const result = classifyAuditActor(entry, context);
        byClass[result.actorClass]++;
        return { ...entry, ...result };
    });
    return { entries: classified, byClass };
}
