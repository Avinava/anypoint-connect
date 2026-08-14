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

    const configuration: CreateDeploymentPayload['application']['configuration'] = {};
    if (input.properties || input.secureProperties) {
        configuration['mule.agent.application.properties.service'] = {
            applicationName: input.appName,
            ...(input.properties ? { properties: input.properties } : {}),
            ...(input.secureProperties ? { secureProperties: input.secureProperties } : {}),
        };
    }

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
            ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
        },
        target: {
            provider: 'MC',
            targetId: region,
            deploymentSettings: {
                runtime: { version: input.runtime || DEFAULT_RUNTIME },
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

/** Merge settings while retaining masked secure entries required by the Application Manager API. */
export function mergeApplicationProperties(
    existing: CH2Deployment,
    properties?: Record<string, string>,
    secureProperties?: Record<string, string>,
): ApplicationPropertiesService {
    const configuration = existing.application.configuration ?? {};
    const service = (configuration['mule.agent.application.properties.service'] ??
        {}) as Partial<ApplicationPropertiesService>;
    return {
        applicationName: existing.name,
        properties: { ...(service.properties ?? {}), ...(properties ?? {}) },
        secureProperties: { ...(service.secureProperties ?? {}), ...(secureProperties ?? {}) },
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
