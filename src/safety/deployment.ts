/**
 * Shared deployment payload logic
 *
 * Single source of truth for building CloudHub 2.0 deployment payloads, used by BOTH
 * the MCP `deploy_app`/`deploy_jar` tools and the CLI `deploy` command. Keeping the
 * create-path builder and the safe artifact-update merge here means the two surfaces
 * cannot drift — in particular, the update path can never re-emit defaulted infra
 * (runtime, target, replicas) and silently downgrade or relocate a running app.
 *
 * These are pure functions (no I/O) so they unit-test cleanly.
 */

import type {
    ApplicationPropertiesService,
    ArtifactRef,
    CH2Deployment,
    CH2DeploymentSpec,
    CreateDeploymentPayload,
} from '../api/CloudHub2Api.js';
import { MASKED, looksSecret, redactValue } from './secrets.js';

export const DEFAULT_RUNTIME = '4.8.0';
export const DEFAULT_REGION = 'cloudhub-us-east-2';
export const DEFAULT_VCORES = '0.1';

/** Allowed CloudHub 2.0 replica (vCore) sizes. */
export const VALID_VCORES = ['0.1', '0.2', '0.5', '1', '1.5', '2', '2.5', '3', '4'] as const;

/**
 * Inputs for a create-path deployment. The MCP zod schema and the CLI `commander`
 * options both map into this one shape, so neither carries its own inline arg type.
 */
export interface DeploymentInput {
    appName: string;
    groupId: string;
    artifactId: string;
    version: string;
    runtime?: string;
    javaVersion?: string;
    releaseChannel?: string;
    replicas?: number;
    region?: string;
    vcores?: string;
    properties?: Record<string, string>;
    secureProperties?: Record<string, string>;
    jvmArgs?: string;
}

/** Map a CloudHub 2.0 target ID to its public-URL subdomain. */
export function regionToSubdomain(region: string): string {
    const map: Record<string, string> = {
        'cloudhub-us-east-1': 'us-e1',
        'cloudhub-us-east-2': 'us-e2',
        'cloudhub-us-west-2': 'us-w2',
        'cloudhub-eu-west-1': 'eu-w1',
        'cloudhub-eu-west-2': 'eu-w2',
        'cloudhub-eu-central-1': 'eu-c1',
        'cloudhub-ap-southeast-1': 'ap-se1',
        'cloudhub-ap-southeast-2': 'ap-se2',
        'cloudhub-ap-northeast-1': 'ap-ne1',
        'cloudhub-sa-east-1': 'sa-e1',
        'cloudhub-ca-central-1': 'ca-c1',
    };
    return map[region] || region.replace('cloudhub-', '').replace(/-/g, '');
}

/**
 * Parse and validate a vCore size string into the numeric value CloudHub 2.0 expects
 * on `application.vCores`. Returns undefined for undefined input; throws on an invalid
 * size so a typo fails loudly instead of silently deploying the wrong allocation.
 */
export function parseVcores(vcores?: string): number | undefined {
    if (vcores === undefined) return undefined;
    if (!VALID_VCORES.includes(vcores as (typeof VALID_VCORES)[number])) {
        throw new Error(`Invalid vCore size "${vcores}". Valid sizes: ${VALID_VCORES.join(', ')}`);
    }
    return parseFloat(vcores);
}

/**
 * Build the payload for CREATING a new deployment. All defaults live here (and only
 * here). This must NOT be used to update an existing deployment — see
 * `mergeForArtifactUpdate` for the safe redeploy path.
 */
export function buildCreatePayload(input: DeploymentInput): CreateDeploymentPayload {
    const region = input.region || DEFAULT_REGION;
    const vCores = parseVcores(input.vcores ?? DEFAULT_VCORES);

    // Always sent, even when empty: a create without the properties service ends FAILED with
    // "Cannot invoke ResourceRef.getId() because r is null".
    const configuration: CreateDeploymentPayload['application']['configuration'] = {
        'mule.agent.application.properties.service': {
            applicationName: input.appName,
            properties: input.properties ?? {},
            secureProperties: input.secureProperties ?? {},
        },
    };

    return {
        name: input.appName,
        application: {
            ref: {
                groupId: input.groupId,
                artifactId: input.artifactId,
                version: input.version,
                packaging: 'jar',
            },
            desiredState: 'STARTED',
            ...(vCores !== undefined ? { vCores } : {}),
            configuration,
        },
        target: {
            provider: 'MC',
            targetId: region,
            deploymentSettings: {
                runtime: {
                    version: input.runtime || DEFAULT_RUNTIME,
                    ...(input.releaseChannel ? { releaseChannel: input.releaseChannel } : {}),
                    ...(input.javaVersion ? { java: input.javaVersion } : {}),
                },
                http: {
                    inbound: {
                        publicUrl: `${input.appName}.${regionToSubdomain(region)}.cloudhub.io`,
                    },
                },
                clustered: false,
                enforceDeployingReplicasAcrossNodes: false,
                updateStrategy: 'rolling',
                ...(input.jvmArgs ? { jvm: { args: input.jvmArgs } } : {}),
            },
            replicas: input.replicas || 1,
        },
    };
}

/** The PATCH body for a safe redeploy: an artifact ref and nothing else. */
export interface ArtifactRefUpdate {
    application: { ref: ArtifactRef };
}

/**
 * Build the body for a SAFE redeploy / rollback of an existing app: it carries ONLY
 * the artifact reference, so the server preserves the live runtime, target/space,
 * replicas, resources, and settings. Any ref field the caller omits is filled from the
 * existing deployment (so callers can pass just a new `version`).
 *
 * The returned object's only key is `application.ref` — this is the invariant the
 * regression test guards. The resolved ref is passed to `CloudHub2Api.updateArtifactRef`.
 */
export function mergeForArtifactUpdate(existing: CH2Deployment, ref: Partial<ArtifactRef>): ArtifactRefUpdate {
    const current = existing.application.ref;
    const merged: ArtifactRef = {
        groupId: ref.groupId ?? current.groupId,
        artifactId: ref.artifactId ?? current.artifactId,
        version: ref.version ?? current.version,
        packaging: ref.packaging ?? current.packaging ?? 'jar',
    };
    return { application: { ref: merged } };
}

export interface RollbackTarget {
    ref: ArtifactRef;
    sourceSpecId?: string;
}

function refsEqual(left: ArtifactRef, right: ArtifactRef): boolean {
    return (
        left.groupId === right.groupId &&
        left.artifactId === right.artifactId &&
        left.version === right.version &&
        left.packaging === right.packaging
    );
}

/** Resolve a rollback to a complete historical artifact ref without confusing spec IDs with artifact versions. */
export function resolveRollbackTarget(
    existing: CH2Deployment,
    specs: CH2DeploymentSpec[],
    toVersion?: string,
): RollbackTarget | null {
    const current = existing.application.ref;
    const priorSpecs = specs.filter((spec) => spec.version !== existing.desiredVersion);

    if (toVersion) {
        const historical = priorSpecs.find(
            (spec) => spec.application?.ref?.version === toVersion && !refsEqual(spec.application.ref, current),
        );
        if (historical) return { ref: historical.application.ref, sourceSpecId: historical.version };
        if (toVersion === current.version) return null;
        return { ref: { ...current, version: toVersion } };
    }

    if (existing.lastSuccessfulVersion && existing.lastSuccessfulVersion !== existing.desiredVersion) {
        const lastSuccessful = specs.find((spec) => spec.version === existing.lastSuccessfulVersion);
        if (lastSuccessful?.application?.ref && !refsEqual(lastSuccessful.application.ref, current)) {
            return { ref: lastSuccessful.application.ref, sourceSpecId: lastSuccessful.version };
        }
    }

    const previousArtifact = priorSpecs.find(
        (spec) => spec.application?.ref && !refsEqual(spec.application.ref, current),
    );
    return previousArtifact ? { ref: previousArtifact.application.ref, sourceSpecId: previousArtifact.version } : null;
}

/** A requested change to an application's properties. Values are already resolved (no file references). */
export interface SettingsChange {
    properties?: Record<string, string>;
    secureProperties?: Record<string, string>;
    removeProperties?: string[];
    removeSecureProperties?: string[];
    /** Plaintext keys whose current value moves into secure properties without leaving the server. */
    moveToSecure?: string[];
}

export interface PropertyChange {
    key: string;
    /** Present only for plaintext keys that do not look secret. */
    from?: string;
    to?: string;
}

export interface SettingsDiff {
    added: PropertyChange[];
    changed: PropertyChange[];
    removed: string[];
    secureAdded: string[];
    secureChanged: string[];
    secureRemoved: string[];
    movedToSecure: string[];
}

export interface SettingsPlan {
    /** The complete properties service to send. The platform replaces the maps wholesale. */
    service: ApplicationPropertiesService;
    diff: SettingsDiff;
    warnings: string[];
    changed: boolean;
}

/** Read the properties service of a live deployment. */
export function currentSettings(existing: CH2Deployment): {
    properties: Record<string, string>;
    secureProperties: Record<string, string>;
} {
    const configuration = existing.application.configuration ?? {};
    const service = (configuration['mule.agent.application.properties.service'] ??
        {}) as Partial<ApplicationPropertiesService>;
    return { properties: { ...(service.properties ?? {}) }, secureProperties: { ...(service.secureProperties ?? {}) } };
}

export function isEmptySettingsChange(change: SettingsChange | undefined): boolean {
    if (!change) return true;
    return (
        Object.keys(change.properties ?? {}).length === 0 &&
        Object.keys(change.secureProperties ?? {}).length === 0 &&
        (change.removeProperties ?? []).length === 0 &&
        (change.removeSecureProperties ?? []).length === 0 &&
        (change.moveToSecure ?? []).length === 0
    );
}

/**
 * Plan a settings change against the live deployment.
 *
 * The platform stores secure values encrypted and returns them as `******`. Sending `******` back
 * for a key keeps its stored value, so every untouched secure key is resent masked; that is what
 * lets one secret change without wiping the others. Removal works because the full maps are sent.
 */
export function planSettingsChange(existing: CH2Deployment, change: SettingsChange): SettingsPlan {
    const current = currentSettings(existing);
    const next = { properties: { ...current.properties }, secureProperties: { ...current.secureProperties } };
    const warnings: string[] = [];
    const errors: string[] = [];
    const diff: SettingsDiff = {
        added: [],
        changed: [],
        removed: [],
        secureAdded: [],
        secureChanged: [],
        secureRemoved: [],
        movedToSecure: [],
    };

    const setPlain = change.properties ?? {};
    const setSecure = change.secureProperties ?? {};
    const removePlain = new Set(change.removeProperties ?? []);
    const removeSecure = new Set(change.removeSecureProperties ?? []);
    const moves = new Set(change.moveToSecure ?? []);

    for (const key of Object.keys(setPlain)) {
        if (key in setSecure) errors.push(`"${key}" is given as both a plain and a secure property`);
        if (removePlain.has(key)) errors.push(`"${key}" is both set and removed`);
        if (moves.has(key)) errors.push(`"${key}" is both set as plain and moved to secure`);
        if (setPlain[key] === MASKED) errors.push(`"${key}": "${MASKED}" is not a valid plain property value`);
    }
    for (const key of Object.keys(setSecure)) {
        if (removeSecure.has(key)) errors.push(`"${key}" is both set and removed`);
        if (setSecure[key] === MASKED && !(key in current.secureProperties)) {
            errors.push(`"${key}": "${MASKED}" keeps a stored secret, but no secure property "${key}" exists`);
        }
        if (key in current.properties && !removePlain.has(key) && !moves.has(key)) {
            errors.push(
                `"${key}" already exists as a plain property. Use moveToSecure to move its current value, or add it to removeProperties`,
            );
        }
    }
    for (const key of moves) {
        if (!(key in current.properties)) {
            if (key in current.secureProperties) warnings.push(`"${key}" is already a secure property`);
            else errors.push(`"${key}" cannot move to secure: no plain property with that name`);
        }
        if (key in setSecure) errors.push(`"${key}" is both moved and given a new secure value`);
    }
    if (errors.length) throw new Error(`Invalid settings change:\n- ${errors.join('\n- ')}`);

    const showValue = (key: string, value: string | undefined) =>
        value === undefined ? undefined : looksSecret(key) ? redactValue(value) : value;

    for (const key of removePlain) {
        if (!(key in next.properties)) {
            warnings.push(`"${key}" is not a plain property; nothing to remove`);
            continue;
        }
        delete next.properties[key];
        diff.removed.push(key);
    }
    for (const key of removeSecure) {
        if (!(key in next.secureProperties)) {
            warnings.push(`"${key}" is not a secure property; nothing to remove`);
            continue;
        }
        delete next.secureProperties[key];
        diff.secureRemoved.push(key);
    }
    for (const key of moves) {
        if (!(key in current.properties)) continue;
        next.secureProperties[key] = current.properties[key];
        delete next.properties[key];
        diff.movedToSecure.push(key);
    }
    for (const [key, value] of Object.entries(setPlain)) {
        const before = current.properties[key];
        if (before === value) continue;
        next.properties[key] = value;
        if (before === undefined) diff.added.push({ key, to: showValue(key, value) });
        else diff.changed.push({ key, from: showValue(key, before), to: showValue(key, value) });
        if (looksSecret(key)) {
            warnings.push(`"${key}" looks like a secret but is stored as plain text; consider secureProperties`);
        }
    }
    for (const [key, value] of Object.entries(setSecure)) {
        if (value === MASKED) continue;
        if (key in current.secureProperties) diff.secureChanged.push(key);
        else diff.secureAdded.push(key);
        next.secureProperties[key] = value;
    }

    const changed =
        diff.added.length +
            diff.changed.length +
            diff.removed.length +
            diff.secureAdded.length +
            diff.secureChanged.length +
            diff.secureRemoved.length +
            diff.movedToSecure.length >
        0;

    return {
        service: {
            applicationName: existing.name,
            properties: next.properties,
            secureProperties: next.secureProperties,
        },
        diff,
        warnings,
        changed,
    };
}

/** A single field that would change between the live deployment and a proposed payload. */
export interface DeploymentChange {
    field: string;
    from: unknown;
    to: unknown;
}

/**
 * Compare a live deployment against a proposed full payload and list the infra fields
 * that would change. Powers the dry-run preview and flags accidental
 * runtime/target/replica changes even on paths that shouldn't touch them.
 */
export function diffDeployment(existing: CH2Deployment, next: CreateDeploymentPayload): DeploymentChange[] {
    const changes: DeploymentChange[] = [];
    const push = (field: string, from: unknown, to: unknown) => {
        if (to !== undefined && from !== to) changes.push({ field, from, to });
    };

    push('version', existing.application?.ref?.version, next.application?.ref?.version);
    push(
        'runtime',
        existing.target?.deploymentSettings?.runtime?.version,
        next.target?.deploymentSettings?.runtime?.version,
    );
    push('targetId', existing.target?.targetId, next.target?.targetId);
    push('vCores', existing.application?.vCores, next.application?.vCores);
    push('replicas', existing.target?.replicas, next.target?.replicas);

    return changes;
}
