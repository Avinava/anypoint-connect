/**
 * JAR deployment workflow
 * Publish a locally built Mule application JAR to Exchange, then create or update its
 * CloudHub 2.0 deployment. Shared by `anc deploy` and the `deploy_jar` MCP tool so both
 * read the artifact's embedded Maven identity and apply the same safety rules.
 */

import { readFile } from 'node:fs/promises';
import type { AnypointClient } from '../client/AnypointClient.js';
import type { CH2Deployment } from '../api/CloudHub2Api.js';
import type { Environment } from '../api/AccessManagementApi.js';
import { inspectArtifact, verifyArtifactDigest } from '../safety/artifact.js';

export type ArtifactInspection = ReturnType<typeof inspectArtifact>;
import {
    DEFAULT_REGION,
    DEFAULT_RUNTIME,
    DEFAULT_VCORES,
    buildCreatePayload,
    mergeForArtifactUpdate,
} from '../safety/deployment.js';
import { validateJarFile } from '../safety/guards.js';

/** Settings that only apply when the application does not exist yet. */
export interface CreateOnlySettings {
    runtime?: string;
    replicas?: number;
    region?: string;
    vcores?: string;
    properties?: Record<string, string>;
    secureProperties?: Record<string, string>;
    jvmArgs?: string;
}

export interface JarDeploymentRequest extends CreateOnlySettings {
    jarPath: string;
    appName: string;
    orgId: string;
    env: Environment;
    assetId?: string;
    assetVersion?: string;
    groupId?: string;
    expectedSha256?: string;
}

export interface JarDeploymentPlan {
    request: JarDeploymentRequest;
    artifact: ArtifactInspection;
    existing: CH2Deployment | null;
    mode: 'create' | 'update';
    ref: { groupId: string; artifactId: string; version: string; packaging: 'jar' };
    /** Create-only settings supplied for an app that already exists (an update must not restate them). */
    rejectedSettings: string[];
}

export interface JarDeploymentResult {
    published: { groupId: string; assetId: string; version: string };
    deployment: CH2Deployment;
}

/** Inspect the JAR and the target environment; nothing is published or deployed. */
export async function planJarDeployment(
    client: AnypointClient,
    request: JarDeploymentRequest,
): Promise<JarDeploymentPlan> {
    const check = validateJarFile(request.jarPath);
    if (!check.valid) throw new Error(check.error);

    const existing = await client.cloudHub2.findDetailByName(request.orgId, request.env.id, request.appName);
    const bytes = await readFile(request.jarPath);
    const artifact = inspectArtifact(bytes, undefined, Boolean(request.assetId && request.assetVersion));
    verifyArtifactDigest(bytes, request.expectedSha256);

    const artifactId = request.assetId || artifact.coordinates?.artifactId;
    const version = request.assetVersion || artifact.coordinates?.version;
    if (!artifactId || !version) {
        throw new Error('Embedded Maven identity is unavailable; supply an explicit asset ID and version');
    }

    const createOnly: Array<keyof CreateOnlySettings> = [
        'runtime',
        'region',
        'vcores',
        'replicas',
        'jvmArgs',
        'properties',
        'secureProperties',
    ];

    return {
        request,
        artifact,
        existing: existing ?? null,
        mode: existing ? 'update' : 'create',
        ref: { groupId: request.groupId || request.orgId, artifactId, version, packaging: 'jar' },
        rejectedSettings: existing ? createOnly.filter((key) => request[key] !== undefined) : [],
    };
}

/** A serializable summary of what {@link executeJarDeployment} will do. */
export function describeJarDeployment(plan: JarDeploymentPlan) {
    const { request, existing, ref, artifact } = plan;
    return {
        action: existing ? 'publish + update artifact ref' : 'publish + create deployment',
        app: request.appName,
        environment: request.env.name,
        artifact,
        expectedSha256: artifact.sha256,
        publish: {
            groupId: ref.groupId,
            assetId: ref.artifactId,
            version: ref.version,
            classifier: 'mule-application',
        },
        deploy: existing
            ? {
                  mode: 'update' as const,
                  from: existing.application?.ref,
                  to: ref,
                  preserved: 'runtime, target/space, replicas, resources, settings',
              }
            : {
                  mode: 'create' as const,
                  ref,
                  runtime: request.runtime || DEFAULT_RUNTIME,
                  region: request.region || DEFAULT_REGION,
                  vcores: request.vcores || DEFAULT_VCORES,
                  replicas: request.replicas || 1,
              },
    };
}

/**
 * Publish the inspected JAR (bound to its SHA-256) and apply the deployment. Existing apps
 * only have their artifact reference changed, preserving runtime, target, replicas and settings.
 */
export async function executeJarDeployment(
    client: AnypointClient,
    plan: JarDeploymentPlan,
): Promise<JarDeploymentResult> {
    if (plan.rejectedSettings.length > 0) {
        throw new Error(
            `"${plan.request.appName}" already exists in ${plan.request.env.name}; only its artifact can change here. ` +
                `Remove: ${plan.rejectedSettings.join(', ')}`,
        );
    }
    const { request, existing, ref, artifact } = plan;

    const published = await client.exchange.publishAppAsset(
        request.orgId,
        ref.groupId,
        ref.artifactId,
        ref.version,
        request.jarPath,
        artifact.sha256,
    );

    const deployment = existing
        ? await client.cloudHub2.updateArtifactRef(
              request.orgId,
              request.env.id,
              existing.id,
              mergeForArtifactUpdate(existing, ref).application.ref,
          )
        : await client.cloudHub2.createDeployment(
              request.orgId,
              request.env.id,
              buildCreatePayload({
                  appName: request.appName,
                  groupId: ref.groupId,
                  artifactId: ref.artifactId,
                  version: ref.version,
                  runtime: request.runtime,
                  replicas: request.replicas,
                  region: request.region,
                  vcores: request.vcores,
                  properties: request.properties,
                  secureProperties: request.secureProperties,
                  jvmArgs: request.jvmArgs,
              }),
          );

    return {
        published: { groupId: published.groupId, assetId: published.assetId, version: published.version },
        deployment,
    };
}
