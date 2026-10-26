/**
 * MCP Tool Registrar — Application read tools
 * list_apps, get_app_status, get_deployment_spec, get_app_resources, get_app_settings, compare_app_deployments,
 * list_runtime_versions, suggest_asset_name
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError, mcpText, resolveEnvironment } from './shared.js';
import { currentSettings } from '../../safety/deployment.js';
import { looksSecret, redactDeep, redactRecord } from '../../safety/secrets.js';
import { parseRuntimeString, resolveRuntime, suggestRuntimes, compareVersions } from '../../safety/runtime.js';
import { deploymentPhase, waitForAppPhase } from '../../workflows/app-state.js';
import { resolveJarArtifact } from '../../workflows/jar-deployment.js';
import { inferConvention, suggestAssetCoordinates } from '../../workflows/asset-naming.js';
import { discoverProjectConfig } from '../../config/profiles.js';
import { errorMessage } from '../../utils/errors.js';

export function registerAppReadTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'list_apps',
        {
            title: 'List Applications',
            description:
                'Lists all Mule applications deployed in a CloudHub 2.0 environment. Returns each app\'s name, deployment status (APPLIED, STARTED, FAILED), artifact version, Mule runtime version, vCores, and replica count. Accepts environment name (e.g. "Development") or environment ID.',
            inputSchema: {
                environment: z
                    .string()
                    .describe('Environment name (e.g. "Development", "Production") or environment ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const deployments = await client.cloudHub2.getDetailedDeployments(orgId, env.id);

                return mcpText(
                    deployments.map((d) => ({
                        name: d.name,
                        status: d.status,
                        version: d.application?.ref?.version,
                        runtime: d.target?.deploymentSettings?.runtime?.version,
                        vCores: d.application?.vCores,
                        replicas: d.target?.replicas,
                        id: d.id,
                    })),
                );
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_app_status',
        {
            title: 'Get Application Status',
            description:
                "Returns detailed deployment information for a specific Mule application: a phase (RUNNING, STARTING, UPDATING, DEGRADED, FAILED, STOPPING, STOPPED) with settled and reason, the raw platform status, artifact version, Mule runtime, resources, autoscaling, JVM args, clustering, each replica's state, the public URL and last update. " +
                'The phase hides the brief FAILED the platform reports while a stopped app starts; FAILED is only reported once it persists past the start-up grace window. ' +
                'Pass wait: true to poll until the app settles or fails.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
                wait: z
                    .boolean()
                    .optional()
                    .describe('Poll until the app is settled, failed or degraded (default: false)'),
                waitSeconds: z.number().min(10).max(1800).optional().describe('Wait limit in seconds (default 300)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, wait, waitSeconds }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                let deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!deployment) {
                    return mcpText(`Application "${appName}" not found in ${env.name}`);
                }

                let snapshot = deploymentPhase(deployment);
                let timedOut = false;
                if (wait && !snapshot.terminal) {
                    const result = await waitForAppPhase(client.cloudHub2, orgId, env.id, deployment.id, {
                        sinceChange: deployment.lastModifiedDate,
                        timeoutMs: waitSeconds ? waitSeconds * 1000 : undefined,
                    });
                    deployment = result.deployment;
                    snapshot = result.snapshot;
                    timedOut = result.timedOut;
                }

                return mcpText({
                    name: deployment.name,
                    phase: snapshot.phase,
                    settled: snapshot.settled,
                    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
                    ...(timedOut ? { timedOut: true } : {}),
                    desiredState: deployment.application?.desiredState,
                    status: deployment.status,
                    version: deployment.application?.ref?.version,
                    groupId: deployment.application?.ref?.groupId,
                    artifactId: deployment.application?.ref?.artifactId,
                    runtime: deployment.target?.deploymentSettings?.runtime?.version,
                    resources: {
                        cpu: deployment.target?.deploymentSettings?.resources?.cpu,
                        memory: deployment.target?.deploymentSettings?.resources?.memory,
                        vCores: deployment.application?.vCores,
                    },
                    autoscaling: deployment.target?.deploymentSettings?.autoscaling,
                    jvm: deployment.target?.deploymentSettings?.jvm,
                    clustered: deployment.target?.deploymentSettings?.clustered,
                    updateStrategy: deployment.target?.deploymentSettings?.updateStrategy,
                    replicas: deployment.replicas?.map((r) => ({
                        id: r.id,
                        state: r.state,
                        location: r.deploymentLocation,
                        onCurrentSpec:
                            !deployment?.desiredVersion || r.currentDeploymentVersion === deployment.desiredVersion,
                        ...(r.reason ? { reason: r.reason } : {}),
                    })),
                    publicUrl: deployment.target?.deploymentSettings?.http?.inbound?.publicUrl,
                    updatedAt: deployment.lastModifiedDate
                        ? new Date(deployment.lastModifiedDate).toISOString()
                        : undefined,
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_deployment_spec',
        {
            title: 'Get Deployment Spec',
            description:
                'Returns the full current deployment spec for a CloudHub 2.0 application — the "look before you leap" view used before a redeploy or rollback. Includes the exact artifact reference (groupId:artifactId:version:packaging), Mule runtime version, deployment target (a private space ID vs a shared cloudhub-* region), vCores, replica count with per-replica state and location, update strategy, clustering, JVM args, public URL, desired vs last-successful version, and timestamps. Unlike get_app_status this always fetches full deployment detail. Use it to confirm exactly what is running before changing an artifact, and to capture the current ref so you can roll back.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const d = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!d) {
                    return mcpText(`Application "${appName}" not found in ${env.name}`);
                }

                const settings = d.target?.deploymentSettings;
                const targetId = d.target?.targetId || '';
                const isPrivateSpace = !targetId.startsWith('cloudhub-');

                return mcpText({
                    name: d.name,
                    deploymentId: d.id,
                    status: d.status,
                    ref: d.application?.ref,
                    runtime: settings?.runtime?.version,
                    target: {
                        provider: d.target?.provider,
                        targetId,
                        kind: isPrivateSpace ? 'private-space' : 'shared-region',
                    },
                    vCores: d.application?.vCores,
                    resources: settings?.resources,
                    replicas: {
                        count: d.target?.replicas ?? 0,
                        states: d.replicas?.map((r) => ({
                            id: r.id,
                            state: r.state,
                            location: r.deploymentLocation,
                            version: r.currentDeploymentVersion,
                        })),
                    },
                    updateStrategy: settings?.updateStrategy,
                    clustered: settings?.clustered,
                    autoscaling: settings?.autoscaling,
                    jvm: settings?.jvm,
                    publicUrl: settings?.http?.inbound?.publicUrl,
                    desiredVersion: d.desiredVersion,
                    lastSuccessfulVersion: d.lastSuccessfulVersion,
                    createdAt: d.creationDate ? new Date(d.creationDate).toISOString() : undefined,
                    updatedAt: d.lastModifiedDate ? new Date(d.lastModifiedDate).toISOString() : undefined,
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_app_resources',
        {
            title: 'Get Application Resources',
            description:
                'Returns resource allocation for all apps in an environment: CPU/memory limits and reservations, vCores, replica count, autoscaling config, and JVM args. Use this to identify over-provisioned or under-provisioned applications, compare resource distribution, and optimize costs.',
            inputSchema: {
                environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const deployments = await client.cloudHub2.getDetailedDeployments(orgId, env.id);

                const resources = deployments.map((d) => ({
                    name: d.name,
                    status: d.status,
                    vCores: d.application?.vCores,
                    cpu: d.target?.deploymentSettings?.resources?.cpu,
                    memory: d.target?.deploymentSettings?.resources?.memory,
                    replicas: d.target?.replicas ?? 0,
                    autoscaling: d.target?.deploymentSettings?.autoscaling,
                    jvm: d.target?.deploymentSettings?.jvm,
                    clustered: d.target?.deploymentSettings?.clustered,
                    updateStrategy: d.target?.deploymentSettings?.updateStrategy,
                }));

                return mcpText({
                    environment: env.name,
                    apps: resources,
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_app_settings',
        {
            title: 'Get Application Settings',
            description:
                'Reads the application properties of a CloudHub 2.0 app: plain properties as key-value pairs and the names of secure properties (their values are never returned). ' +
                'Plain properties whose names look like secrets (password, secret, token, key, credential) are masked by default and listed under warnings with a fix: update_app_settings moveToSecure. Pass redact: false to see them.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
                redact: z
                    .boolean()
                    .optional()
                    .describe('Mask plain properties whose names look like secrets (default: true)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, redact }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const detail = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!detail) {
                    return mcpText(`Application "${appName}" not found in ${env.name}`);
                }

                const { properties, secureProperties } = currentSettings(detail);
                const secretLooking = Object.keys(properties).filter((key) => looksSecret(key));
                const { 'mule.agent.application.properties.service': _service, ...otherServices } = (detail.application
                    ?.configuration ?? {}) as Record<string, unknown>;

                return mcpText({
                    appName: detail.name,
                    environment: env.name,
                    properties: redact === false ? properties : redactRecord(properties),
                    securePropertyKeys: Object.keys(secureProperties),
                    ...(secretLooking.length
                        ? {
                              warnings: secretLooking.map((key) => ({
                                  key,
                                  issue: 'secret-like key stored as a plain property',
                                  fix: `update_app_settings with moveToSecure: ["${key}"]`,
                              })),
                          }
                        : {}),
                    ...(Object.keys(otherServices).length ? { otherConfiguration: redactDeep(otherServices) } : {}),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'compare_app_deployments',
        {
            title: 'Compare Environments',
            description:
                'Produces a side-by-side comparison of all application deployments across two environments. For each app, shows deployment status, artifact version, and replica count in both environments, plus whether versions match. Use this to detect environment drift before a production promotion, verify that a release was applied consistently, or audit differences between Development and Production.',
            inputSchema: {
                env1: z.string().describe('First environment name (e.g. "Development")'),
                env2: z.string().describe('Second environment name (e.g. "Production")'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ env1, env2 }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const [e1, e2] = await Promise.all([
                    client.accessManagement.resolveEnvironment(orgId, env1),
                    client.accessManagement.resolveEnvironment(orgId, env2),
                ]);

                const [apps1, apps2] = await Promise.all([
                    client.cloudHub2.getDetailedDeployments(orgId, e1.id),
                    client.cloudHub2.getDetailedDeployments(orgId, e2.id),
                ]);

                const allNames = new Set([...apps1.map((a) => a.name), ...apps2.map((a) => a.name)]);

                const comparison = Array.from(allNames)
                    .sort()
                    .map((name) => {
                        const a1 = apps1.find((a) => a.name === name);
                        const a2 = apps2.find((a) => a.name === name);
                        return {
                            name,
                            [e1.name]: a1
                                ? {
                                      status: a1.status,
                                      version: a1.application?.ref?.version || '-',
                                      replicas: a1.target?.replicas || 0,
                                  }
                                : 'NOT DEPLOYED',
                            [e2.name]: a2
                                ? {
                                      status: a2.status,
                                      version: a2.application?.ref?.version || '-',
                                      replicas: a2.target?.replicas || 0,
                                  }
                                : 'NOT DEPLOYED',
                            versionMatch:
                                a1 && a2 ? a1.application?.ref?.version === a2.application?.ref?.version : null,
                        };
                    });

                return mcpText({ comparison });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'list_runtime_versions',
        {
            title: 'List Runtime Versions',
            description:
                "Lists the Mule runtime versions a CloudHub 2.0 target accepts, with release channel and Java versions. Pass appName to use that app's target and see whether its current runtime is still offered, with the nearest supported versions when it is not. Use before update_app with runtime.",
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                appName: z
                    .string()
                    .optional()
                    .describe('Application whose target to check (and whose runtime to evaluate)'),
                targetId: z.string().optional().describe('Target ID, e.g. "cloudhub-us-east-2" or a private space ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, appName, targetId }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const app = appName ? await client.cloudHub2.findDetailByName(orgId, env.id, appName) : null;
                if (appName && !app) return mcpText(`Application "${appName}" not found in ${env.name}`);
                const resolvedTarget = targetId ?? app?.target?.targetId;
                if (!resolvedTarget) {
                    const targets = await client.runtimes.getTargets(orgId);
                    return mcpText({
                        targets: targets.map((t) => ({
                            id: t.id,
                            name: t.name,
                            type: t.type,
                            versions: t.runtimes.length,
                        })),
                        tip: "Pass targetId or appName to list one target's versions.",
                    });
                }

                const target = await client.runtimes.getTarget(orgId, resolvedTarget);
                if (!target) return mcpText(`Target "${resolvedTarget}" is not in the organization's runtime catalog`);
                const versions = [...target.runtimes].sort((a, b) => compareVersions(b.version, a.version));
                const runtime = app?.target?.deploymentSettings?.runtime;
                const current = runtime ? parseRuntimeString(runtime.version, runtime.java) : undefined;
                const supported = current ? Boolean(resolveRuntime(target.runtimes, current)) : undefined;

                return mcpText({
                    targetId: target.id,
                    ...(target.name ? { name: target.name } : {}),
                    ...(current
                        ? {
                              app: app?.name,
                              current: {
                                  version: current.version,
                                  java: current.java,
                                  releaseChannel: runtime?.releaseChannel,
                                  supported,
                              },
                              ...(supported === false
                                  ? { suggestions: suggestRuntimes(target.runtimes, current) }
                                  : {}),
                          }
                        : {}),
                    versions,
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'suggest_asset_name',
        {
            title: 'Suggest Asset Name',
            description:
                "Suggests the Exchange coordinates for publishing an app's next JAR: the project's naming convention (.anypoint-connect.json conventions), otherwise the pattern of the asset the app runs today (for example {app}-{pomVersion}-{timestamp} at a fixed version), otherwise the JAR's Maven identity. Reports which rule chose each value. deploy_jar applies explicit values and the project convention, and only reports the deployed pattern.",
            inputSchema: {
                appName: z.string().describe('Application name'),
                environment: z.string().describe('Environment whose deployed asset shows the current pattern'),
                jarPath: z.string().optional().describe('Built JAR, to fill {pomVersion} and {artifactId}'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, jarPath }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const app = await client.cloudHub2.findDetailByName(orgId, env.id, appName);
                const existingRef = app?.application?.ref;
                const project = discoverProjectConfig()?.conventions;
                const inferred = existingRef ? inferConvention(appName, existingRef) : undefined;
                const jar = jarPath
                    ? (await resolveJarArtifact({ jarPath, orgId, appName, existingRef })).artifact.coordinates
                    : undefined;
                // Without a JAR, templates that need {pomVersion} cannot be filled; report the pattern anyway.
                let suggestion: ReturnType<typeof suggestAssetCoordinates> | null = null;
                let unresolved: string | undefined;
                try {
                    suggestion = suggestAssetCoordinates({
                        app: appName,
                        orgId,
                        jar,
                        existingRef,
                        convention: project,
                        applyInferred: true,
                    });
                } catch (error) {
                    unresolved = `${errorMessage(error)}${jar ? '' : '. Pass jarPath to fill {pomVersion} and {artifactId}'}`;
                }

                return mcpText({
                    suggestion,
                    ...(unresolved ? { unresolved } : {}),
                    deployedRef: existingRef ?? null,
                    projectConvention: project ?? null,
                    deployedPattern: inferred ?? null,
                    ...(project
                        ? {}
                        : inferred
                          ? {
                                tip: `deploy_jar does not apply the deployed pattern on its own. Pass assetId/assetVersion, or add "conventions": ${JSON.stringify(inferred)} to .anypoint-connect.json.`,
                            }
                          : {}),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
