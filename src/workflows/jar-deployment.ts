/**
 * JAR deployment workflow
 * Publish a locally built Mule application JAR to Exchange, then create or update its
 * CloudHub 2.0 deployment. Shared by `anc deploy` and the `deploy_jar` MCP tool so both
 * read the artifact's embedded Maven identity and apply the same safety rules. Updates to an
 * existing app go through the application change workflow (one PATCH, runtime check, modes).
 */

import type { AnypointClient } from '../client/AnypointClient.js';
import type { ArtifactRef, CH2Deployment } from '../api/CloudHub2Api.js';
import type { Environment } from '../api/AccessManagementApi.js';
import {
    checkBuildProvenance,
    inspectArtifact,
    readBuildProvenance,
    verifyArtifactDigest,
    type BuildProvenance,
    type ProvenanceCheck,
} from '../safety/artifact.js';
import {
    DEFAULT_REGION,
    DEFAULT_RUNTIME,
    DEFAULT_VCORES,
    buildCreatePayload,
    isEmptySettingsChange,
} from '../safety/deployment.js';
import { isProductionEnv } from '../safety/guards.js';
import { checkUnmarkedAllowance } from '../safety/preapproval.js';
import { readJarBytes } from './artifact-verification.js';
import type { RuntimeSpec } from '../safety/runtime.js';
import { redactText } from '../safety/secrets.js';
import { discoverProjectConfig } from '../config/profiles.js';
import {
    describeAppChange,
    executeAppChange,
    planAppChange,
    resolveSettingsInput,
    type AppChangePlan,
    type AppChangeResult,
    type ChangeMode,
    type ExecuteOptions,
    type SettingsChangeInput,
    type UpdateStrategy,
} from './app-change.js';
import { waitForAppPhase, type PhaseSnapshot } from './app-state.js';
import { gitShortHash, suggestAssetCoordinates, type AssetConvention, type AssetSuggestion } from './asset-naming.js';

export type ArtifactInspection = ReturnType<typeof inspectArtifact>;

/** Settings that only apply when the application does not exist yet. */
export interface CreateOnlySettings {
    replicas?: number;
    region?: string;
    vcores?: string;
    jvmArgs?: string;
}

export interface JarDeploymentRequest extends CreateOnlySettings, JarArtifactRequest {
    appName: string;
    env: Environment;
    /** Runtime for a new app, or the runtime to move an existing app to. */
    runtime?: RuntimeSpec;
    settings?: SettingsChangeInput;
    mode?: ChangeMode;
    updateStrategy?: UpdateStrategy;
}

export interface JarDeploymentPlan {
    request: JarDeploymentRequest;
    artifact: ArtifactInspection;
    existing: CH2Deployment | null;
    mode: 'create' | 'update';
    ref: ArtifactRef & { packaging: 'jar' };
    naming: AssetSuggestion;
    /** Create-only settings supplied for an app that already exists (an update must not restate them). */
    rejectedSettings: string[];
    /** The change applied to an existing app after publishing. */
    change?: AppChangePlan;
    /** Settings resolved for a new app. */
    createSettings?: { properties?: Record<string, string>; secureProperties?: Record<string, string> };
    /** The jar's build marker checked against the target environment. */
    provenance: ProvenanceCheck;
    /** Problems that stop the deployment before anything is published (provenance, then the change's own). */
    blockers: string[];
    secretValues: string[];
}

export interface JarDeploymentResult {
    published: { groupId: string; assetId: string; version: string };
    deployment: CH2Deployment;
    change?: AppChangeResult;
    snapshot?: PhaseSnapshot;
    timedOut?: boolean;
}

export interface JarArtifactRequest {
    jarPath: string;
    orgId: string;
    assetId?: string;
    assetVersion?: string;
    groupId?: string;
    expectedSha256?: string;
    /** Application the asset is for; enables naming conventions. */
    appName?: string;
    /** The app's currently deployed ref, used to infer its naming pattern. */
    existingRef?: ArtifactRef;
    /** Naming convention. Default: the project's .anypoint-connect.json conventions. */
    convention?: AssetConvention | null;
}

/**
 * Validate a JAR, bind it to its SHA-256, and choose its Exchange coordinates: explicit values first,
 * then the naming convention, then the deployed asset's pattern, then the embedded Maven identity.
 */
export async function resolveJarArtifact(request: JarArtifactRequest): Promise<{
    artifact: ArtifactInspection;
    ref: JarDeploymentPlan['ref'];
    naming: AssetSuggestion;
    provenance: BuildProvenance;
}> {
    const bytes = await readJarBytes(request.jarPath);
    const artifact = inspectArtifact(bytes, undefined, Boolean(request.assetId && request.assetVersion));
    verifyArtifactDigest(bytes, request.expectedSha256);
    const provenance = readBuildProvenance(bytes);

    const convention =
        request.convention === undefined ? discoverProjectConfig()?.conventions : (request.convention ?? undefined);
    const usesGit = [convention?.assetId, convention?.assetVersion].some((t) => t?.includes('{gitShort}'));
    const naming = suggestAssetCoordinates({
        app: request.appName ?? artifact.coordinates?.artifactId ?? request.assetId ?? 'app',
        orgId: request.orgId,
        jar: artifact.coordinates,
        existingRef: request.existingRef,
        convention,
        explicit: { assetId: request.assetId, assetVersion: request.assetVersion, groupId: request.groupId },
        gitShort: usesGit ? gitShortHash() : undefined,
    });
    return {
        artifact,
        naming,
        provenance,
        ref: { groupId: naming.groupId, artifactId: naming.assetId, version: naming.version, packaging: 'jar' },
    };
}

/**
 * Check a jar's build marker against an environment (or no environment, when only publishing). A
 * production target also consults the unmarked-artifact allowance for the org and environment.
 */
export function checkJarForEnvironment(
    provenance: BuildProvenance,
    orgId: string,
    env: Pick<Environment, 'id' | 'name' | 'isProduction'> | undefined,
): ProvenanceCheck {
    if (!env) return checkBuildProvenance(provenance, undefined);
    const production = isProductionEnv(env.name, env.isProduction);
    return checkBuildProvenance(
        provenance,
        production,
        production ? checkUnmarkedAllowance({ orgId, env }) : undefined,
    );
}

/** Inspect the JAR and the target environment; nothing is published or deployed. */
export async function planJarDeployment(
    client: AnypointClient,
    request: JarDeploymentRequest,
): Promise<JarDeploymentPlan> {
    const existing = await client.cloudHub2.findDetailByName(request.orgId, request.env.id, request.appName);
    const { artifact, ref, naming, provenance } = await resolveJarArtifact({
        ...request,
        existingRef: existing?.application?.ref,
    });
    const { change: settings, secretValues } = resolveSettingsInput(request.settings);
    const provenanceCheck = checkJarForEnvironment(provenance, request.orgId, request.env);
    const provenanceBlockers = provenanceCheck.blocker ? [provenanceCheck.blocker] : [];

    const createOnly: Array<keyof CreateOnlySettings> = ['region', 'vcores', 'replicas', 'jvmArgs'];
    const base = {
        request,
        artifact,
        existing: existing ?? null,
        ref,
        naming,
        provenance: provenanceCheck,
        secretValues,
    };

    if (!existing) {
        if (settings?.removeProperties || settings?.removeSecureProperties || settings?.moveToSecure) {
            throw new Error('removeProperties, removeSecureProperties and moveToSecure apply only to an existing app');
        }
        return {
            ...base,
            mode: 'create',
            rejectedSettings: [],
            blockers: provenanceBlockers,
            createSettings: { properties: settings?.properties, secureProperties: settings?.secureProperties },
        };
    }

    const rejectedSettings = createOnly.filter((key) => request[key] !== undefined);
    if (rejectedSettings.length) return { ...base, mode: 'update', rejectedSettings, blockers: provenanceBlockers };

    const change = await planAppChange(client, {
        orgId: request.orgId,
        env: request.env,
        appName: request.appName,
        existing,
        ref,
        runtime: request.runtime,
        settings: isEmptySettingsChange(settings) ? undefined : settings,
        updateStrategy: request.updateStrategy,
        mode: request.mode,
        secretValues,
        // These exact bytes are checked above and published, bound to their SHA-256, before the change.
        artifactVerifiedLocally: true,
    });
    return {
        ...base,
        mode: 'update',
        rejectedSettings: [],
        blockers: [...provenanceBlockers, ...change.blockers],
        change,
    };
}

/** A serializable summary of what {@link executeJarDeployment} will do. Never contains secret values. */
export function describeJarDeployment(plan: JarDeploymentPlan) {
    const { request, existing, ref, artifact, naming } = plan;
    const summary = {
        action: existing ? 'publish + update application' : 'publish + create deployment',
        app: request.appName,
        environment: request.env.name,
        artifact,
        expectedSha256: artifact.sha256,
        buildProvenance: plan.provenance.buildProvenance,
        ...(plan.provenance.provenancePolicy ? { provenancePolicy: plan.provenance.provenancePolicy } : {}),
        ...(plan.provenance.warnings.length ? { provenanceWarnings: plan.provenance.warnings } : {}),
        ...(plan.provenance.blocker ? { blockers: [plan.provenance.blocker] } : {}),
        publish: {
            groupId: ref.groupId,
            assetId: ref.artifactId,
            version: ref.version,
            classifier: 'mule-application',
            naming: naming.rules,
            ...(naming.convention ? { convention: naming.convention } : {}),
        },
        deploy:
            existing && plan.change
                ? { action: 'update' as const, ...describeAppChange(plan.change) }
                : {
                      action: 'create' as const,
                      ref,
                      runtime: request.runtime?.version || DEFAULT_RUNTIME,
                      ...(request.runtime?.java ? { java: request.runtime.java } : {}),
                      region: request.region || DEFAULT_REGION,
                      vcores: request.vcores || DEFAULT_VCORES,
                      replicas: request.replicas || 1,
                      properties: Object.keys(plan.createSettings?.properties ?? {}),
                      secureProperties: Object.keys(plan.createSettings?.secureProperties ?? {}),
                  },
        ...(plan.rejectedSettings.length ? { rejectedSettings: plan.rejectedSettings } : {}),
    };
    return JSON.parse(redactText(JSON.stringify(summary), plan.secretValues)) as typeof summary;
}

/**
 * Publish the inspected JAR (bound to its SHA-256) and apply the deployment. Existing apps change
 * only what the plan lists; target, replicas, resources and untouched settings are preserved.
 */
export async function executeJarDeployment(
    client: AnypointClient,
    plan: JarDeploymentPlan,
    options: ExecuteOptions = {},
): Promise<JarDeploymentResult> {
    if (plan.rejectedSettings.length > 0) {
        throw new Error(
            `"${plan.request.appName}" already exists in ${plan.request.env.name}; region, vCores, replicas and JVM arguments cannot change here. ` +
                `Remove: ${plan.rejectedSettings.join(', ')}`,
        );
    }
    if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
    const { request, existing, ref, artifact } = plan;

    const published = await client.exchange.publishAppAsset(
        request.orgId,
        ref.groupId,
        ref.artifactId,
        ref.version,
        request.jarPath,
        artifact.sha256,
    );
    const publishedRef = { groupId: published.groupId, assetId: published.assetId, version: published.version };

    if (existing && plan.change) {
        const change = await executeAppChange(client, plan.change, options);
        return {
            published: publishedRef,
            deployment: change.deployment,
            change,
            snapshot: change.snapshot,
            timedOut: change.timedOut,
        };
    }

    const sentAt = Date.now();
    const deployment = await client.cloudHub2.createDeployment(
        request.orgId,
        request.env.id,
        buildCreatePayload({
            appName: request.appName,
            groupId: ref.groupId,
            artifactId: ref.artifactId,
            version: ref.version,
            runtime: request.runtime?.version,
            javaVersion: request.runtime?.java,
            releaseChannel: request.runtime?.releaseChannel,
            replicas: request.replicas,
            region: request.region,
            vcores: request.vcores,
            properties: plan.createSettings?.properties,
            secureProperties: plan.createSettings?.secureProperties,
            jvmArgs: request.jvmArgs,
        }),
    );
    if (!options.wait) return { published: publishedRef, deployment };
    const result = await waitForAppPhase(client.cloudHub2, request.orgId, request.env.id, deployment.id, {
        sinceChange: sentAt,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        graceMs: options.graceMs,
        onStatus: options.onStatus ? (snapshot) => options.onStatus?.('create', snapshot) : undefined,
    });
    return {
        published: publishedRef,
        deployment: result.deployment,
        snapshot: result.snapshot,
        timedOut: result.timedOut,
    };
}
