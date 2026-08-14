import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError, mcpText, dryRunPreview } from './shared.js';
import {
    buildCreatePayload,
    mergeApplicationProperties,
    mergeForArtifactUpdate,
    resolveRollbackTarget,
} from '../../safety/deployment.js';
import { buildApplicationDeletionPreview, deploymentIdMatches } from '../../safety/deletion.js';
import { errorMessage } from '../../utils/errors.js';

export function registerApplicationTools(server: McpServer, client: AnypointClient) {
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
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const deployments = await client.cloudHub2.getDetailedDeployments(orgId, env.id);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                deployments.map((d) => ({
                                    name: d.name,
                                    status: d.status,
                                    version: d.application?.ref?.version,
                                    runtime: d.target?.deploymentSettings?.runtime?.version,
                                    vCores: d.application?.vCores,
                                    replicas: d.target?.replicas,
                                    id: d.id,
                                })),
                                null,
                                2,
                            ),
                        },
                    ],
                };
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
                "Returns detailed deployment information for a specific Mule application: status, artifact version (groupId:artifactId:version), Mule runtime version, resource allocation (CPU, memory, vCores), autoscaling config, JVM args, clustering, each replica's state and deployment location, the public URL, and last update timestamp. Use this to check if an app is healthy, review resource allocation, or verify a deployment.",
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                    };
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    name: deployment.name,
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
                                    })),
                                    publicUrl: deployment.target?.deploymentSettings?.http?.inbound?.publicUrl,
                                    updatedAt: deployment.lastModifiedDate
                                        ? new Date(deployment.lastModifiedDate).toISOString()
                                        : undefined,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
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
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
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
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
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

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    apps: resources,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
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
                'Reads the application properties (configuration settings) for a deployed Mule application in CloudHub 2.0. Returns both plain-text properties as key-value pairs and the names of secure (encrypted) properties. Use this to verify configuration after a deploy, compare settings between environments, or check for missing properties.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const detail = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!detail) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                    };
                }

                const config = (detail.application?.configuration ?? {}) as Record<string, unknown>;
                const propertiesService = config['mule.agent.application.properties.service'] as
                    | Record<string, unknown>
                    | undefined;
                const properties = (propertiesService?.properties ?? {}) as Record<string, string>;
                const secureProperties = propertiesService?.secureProperties as Record<string, string> | undefined;
                const securePropertyKeys = secureProperties ? Object.keys(secureProperties) : [];

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    appName: detail.name,
                                    environment: env.name,
                                    properties,
                                    securePropertyKeys,
                                    rawConfiguration: config,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'restart_app',
        {
            title: 'Restart Application',
            description:
                "Initiates a rolling restart of a deployed Mule application by re-applying its desired state. This causes new replicas to spin up before old ones are terminated, avoiding downtime. Use when an app is behaving unexpectedly (e.g. memory issues, stale connections) but you don't need to redeploy a new version.",
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ appName, environment }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                await client.cloudHub2.restartApp(orgId, env.id, deployment.id);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Rolling restart initiated for "${appName}" in ${env.name}. Use get_app_status to monitor progress.`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'scale_app',
        {
            title: 'Scale Application',
            description:
                'Changes the number of running replicas for a CloudHub 2.0 application. Scaling up adds more replicas for higher throughput and availability; scaling down reduces cost. Each replica runs as an isolated Mule runtime instance. The change takes effect immediately and new replicas will begin receiving traffic once their health checks pass.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                replicas: z.number().min(1).max(8).describe('Desired number of replicas (1–8)'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ appName, environment, replicas }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                await client.cloudHub2.scaleApp(orgId, env.id, deployment.id, replicas);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Scaled "${appName}" to ${replicas} replica(s) in ${env.name}. Use get_app_status to monitor.`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    // ── New tools ─────────────────────────────────────────

    server.registerTool(
        'deploy_app',
        {
            title: 'Deploy Application',
            description:
                'Deploys or redeploys a Mule application to CloudHub 2.0 using Maven coordinates (groupId:artifactId:version) referencing an artifact already published to Exchange. If the application already exists it will be updated (redeployed); otherwise a new deployment is created. Returns the deployment ID and initial status — use get_app_status to monitor progress.',
            inputSchema: {
                appName: z.string().describe('Application name (used as deployment name and public URL slug)'),
                environment: z.string().describe('Environment name (e.g. "Sandbox", "Production") or environment ID'),
                groupId: z.string().describe('Maven group ID of the application artifact (usually the org ID)'),
                artifactId: z.string().describe('Maven artifact ID (e.g. "order-management-api")'),
                version: z.string().describe('Artifact version (e.g. "1.2.0", "1.0.0-SNAPSHOT")'),
                runtime: z
                    .string()
                    .optional()
                    .describe('Mule runtime version (default: "4.8.0"). Examples: "4.6.0", "4.7.0", "4.8.0"'),
                replicas: z.number().min(1).max(8).optional().describe('Number of replicas (default: 1, max: 8)'),
                region: z
                    .string()
                    .optional()
                    .describe(
                        'CloudHub 2.0 target region (default: "cloudhub-us-east-2"). Examples: "cloudhub-us-east-1", "cloudhub-eu-west-1", "cloudhub-ap-southeast-1"',
                    ),
                vcores: z
                    .string()
                    .optional()
                    .describe(
                        'vCore size (default: "0.1"). Options: "0.1", "0.2", "0.5", "1", "1.5", "2", "2.5", "3", "4"',
                    ),
                properties: z
                    .record(z.string())
                    .optional()
                    .describe('Application properties as key-value pairs to set on deploy'),
                secureProperties: z
                    .record(z.string())
                    .optional()
                    .describe('Secure (encrypted) application properties as key-value pairs'),
                jvmArgs: z.string().optional().describe('JVM arguments (e.g. "-XX:MaxMetaspaceSize=256m")'),
                confirm: z
                    .boolean()
                    .optional()
                    .describe('Set true to apply. When omitted/false, returns a dry-run preview and changes nothing.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({
            appName,
            environment,
            groupId,
            artifactId,
            version,
            runtime,
            replicas,
            region,
            vcores,
            properties,
            secureProperties,
            jvmArgs,
            confirm,
        }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const existing = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                // ── Update path: existing app → SAFE artifact-ref-only redeploy ──
                // Infra params (runtime/region/vcores/replicas/jvmArgs) are intentionally NOT
                // restated here; doing so previously clobbered the live deployment. They are
                // ignored on redeploy and the caller is told so.
                if (existing) {
                    const ignored = [
                        runtime && 'runtime',
                        region && 'region',
                        vcores && 'vcores',
                        replicas && 'replicas',
                        jvmArgs && 'jvmArgs',
                        properties && 'properties',
                        secureProperties && 'secureProperties',
                    ].filter(Boolean);

                    const merged = mergeForArtifactUpdate(existing, { groupId, artifactId, version });
                    const currentVersion = existing.application?.ref?.version || null;

                    if (!confirm) {
                        return dryRunPreview({
                            action: 'redeploy (artifact ref only)',
                            app: appName,
                            environment: env.name,
                            current: {
                                version: currentVersion,
                                runtime: existing.target?.deploymentSettings?.runtime?.version,
                                targetId: existing.target?.targetId,
                                replicas: existing.target?.replicas,
                            },
                            next: { ref: merged.application.ref },
                            preserved: 'runtime, target/space, replicas, resources, settings',
                            ...(ignored.length
                                ? {
                                      note: `Ignored on redeploy (use update_app_settings / a fresh deploy to change infra): ${ignored.join(', ')}`,
                                  }
                                : {}),
                        });
                    }

                    const deployment = await client.cloudHub2.updateArtifactRef(
                        orgId,
                        env.id,
                        existing.id,
                        merged.application.ref,
                    );

                    return mcpText({
                        message: `✅ Redeployed "${appName}" in ${env.name} (artifact ref only)`,
                        deploymentId: deployment.id,
                        status: deployment.status,
                        version: `${groupId}:${artifactId}:${version}`,
                        previousVersion: currentVersion,
                        preserved: 'runtime, target/space, replicas, resources, settings',
                        ...(ignored.length ? { ignored } : {}),
                        tip: 'Use get_app_status to monitor deployment progress.',
                    });
                }

                // ── Create path: new app → full payload from the shared builder ──
                const payload = buildCreatePayload({
                    appName,
                    groupId,
                    artifactId,
                    version,
                    runtime,
                    replicas,
                    region,
                    vcores,
                    properties,
                    secureProperties,
                    jvmArgs,
                });

                if (!confirm) {
                    return dryRunPreview({
                        action: 'create new deployment',
                        app: appName,
                        environment: env.name,
                        next: {
                            version: `${groupId}:${artifactId}:${version}`,
                            runtime: payload.target.deploymentSettings.runtime.version,
                            region: payload.target.targetId,
                            vCores: payload.application.vCores,
                            replicas: payload.target.replicas,
                        },
                    });
                }

                const deployment = await client.cloudHub2.createDeployment(orgId, env.id, payload);

                return mcpText({
                    message: `✅ Created new deployment for "${appName}" in ${env.name}`,
                    deploymentId: deployment.id,
                    status: deployment.status,
                    version: `${groupId}:${artifactId}:${version}`,
                    runtime: payload.target.deploymentSettings.runtime.version,
                    vCores: payload.application.vCores,
                    replicas: payload.target.replicas,
                    region: payload.target.targetId,
                    tip: 'Use get_app_status to monitor deployment progress.',
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'update_app_artifact',
        {
            title: 'Update Application Artifact (Safe Redeploy)',
            description:
                'Safely redeploys an existing CloudHub 2.0 application to a new artifact version by PATCHing ONLY the application reference. The live Mule runtime, deployment target/space, replica count, resources, and settings are all preserved — this is the correct tool for a production version bump, and is preferred over deploy_app for existing apps. Optionally waits for the deployment to reach a running state. Pass confirm:true to apply; without it you get a dry-run preview of the ref change.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
                version: z.string().describe('New artifact version to deploy (e.g. "1.4.12")'),
                artifactId: z.string().optional().describe('Maven artifact ID. Default: keep the existing one.'),
                groupId: z.string().optional().describe('Maven group ID. Default: keep the existing one.'),
                packaging: z
                    .string()
                    .optional()
                    .describe('Artifact packaging. Default: keep existing (usually "jar").'),
                wait: z
                    .boolean()
                    .optional()
                    .describe('Wait for the redeploy to reach a running state before returning (default: false).'),
                confirm: z
                    .boolean()
                    .optional()
                    .describe('Set true to apply. When omitted/false, returns a dry-run preview and changes nothing.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({ appName, environment, version, artifactId, groupId, packaging, wait, confirm }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const existing = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!existing) {
                    return mcpText(
                        `Application "${appName}" not found in ${env.name}. Use deploy_app to create a new deployment.`,
                    );
                }

                const merged = mergeForArtifactUpdate(existing, { groupId, artifactId, version, packaging });
                const oldRef = existing.application?.ref;

                if (!confirm) {
                    return dryRunPreview({
                        action: 'update artifact ref (safe redeploy)',
                        app: appName,
                        environment: env.name,
                        current: { ref: oldRef },
                        next: { ref: merged.application.ref },
                        preserved: 'runtime, target/space, replicas, resources, settings',
                    });
                }

                let deployment = await client.cloudHub2.updateArtifactRef(
                    orgId,
                    env.id,
                    existing.id,
                    merged.application.ref,
                );

                let waitResult: string | undefined;
                if (wait) {
                    try {
                        deployment = await client.cloudHub2.waitForDeployment(orgId, env.id, deployment.id);
                        waitResult = deployment.status;
                    } catch (waitErr) {
                        waitResult = `did not settle: ${errorMessage(waitErr)}`;
                    }
                }

                return mcpText({
                    message: `✅ Updated "${appName}" in ${env.name} to v${version}`,
                    deploymentId: deployment.id,
                    status: deployment.status,
                    from: oldRef,
                    to: merged.application.ref,
                    preserved: 'runtime, target/space, replicas, resources, settings',
                    ...(wait ? { waitResult } : { tip: 'Pass wait:true or use get_app_status to monitor progress.' }),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'rollback_app',
        {
            title: 'Roll Back Application',
            description:
                'Rolls an existing CloudHub 2.0 application back to a previous artifact by PATCHing only the application reference (runtime, target, replicas, and settings are preserved). By default it resolves the last successful or newest distinct historical artifact ref; pass toVersion to select a specific artifact version. Pass confirm:true to apply; without it you get a dry-run preview.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
                toVersion: z
                    .string()
                    .optional()
                    .describe('Artifact version to roll back to. Default: newest distinct historical artifact.'),
                wait: z
                    .boolean()
                    .optional()
                    .describe('Wait for the rollback to reach a running state (default: false).'),
                confirm: z
                    .boolean()
                    .optional()
                    .describe('Set true to apply. When omitted/false, returns a dry-run preview and changes nothing.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({ appName, environment, toVersion, wait, confirm }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const existing = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!existing) {
                    return mcpText(`Application "${appName}" not found in ${env.name}`);
                }

                const specs = await client.cloudHub2.getDeploymentSpecs(orgId, env.id, existing.id);
                const target = resolveRollbackTarget(existing, specs, toVersion);

                if (!target) {
                    return mcpText(
                        `No distinct rollback target for "${appName}" in ${env.name}. ` +
                            'Pass toVersion to select a specific artifact version.',
                    );
                }

                if (!confirm) {
                    return dryRunPreview({
                        action: 'rollback (artifact ref only)',
                        app: appName,
                        environment: env.name,
                        current: { ref: existing.application.ref, specId: existing.desiredVersion },
                        next: { ref: target.ref, sourceSpecId: target.sourceSpecId },
                        preserved: 'runtime, target/space, replicas, resources, settings',
                    });
                }

                let deployment = await client.cloudHub2.rollbackToRef(orgId, env.id, existing.id, target.ref);

                let waitResult: string | undefined;
                if (wait) {
                    try {
                        deployment = await client.cloudHub2.waitForDeployment(orgId, env.id, deployment.id);
                        waitResult = deployment.status;
                    } catch (waitErr) {
                        waitResult = `did not settle: ${errorMessage(waitErr)}`;
                    }
                }

                return mcpText({
                    message: `✅ Rolled back "${appName}" in ${env.name}: ${existing.application.ref.version} → ${target.ref.version}`,
                    deploymentId: deployment.id,
                    status: deployment.status,
                    rolledBackFrom: existing.application.ref,
                    rolledBackTo: target.ref,
                    sourceSpecId: target.sourceSpecId,
                    preserved: 'runtime, target/space, replicas, resources, settings',
                    ...(wait ? { waitResult } : {}),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'update_app_settings',
        {
            title: 'Update Application Settings',
            description:
                'Updates application properties for a deployed Mule application in CloudHub 2.0. Merges the provided properties with existing ones (does not remove properties not specified). Triggers a rolling restart to apply the new configuration. Use this to change environment-specific config like database URLs, API keys, or feature flags without redeploying a new JAR.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name or ID'),
                properties: z
                    .record(z.string())
                    .optional()
                    .describe('Plain-text application properties to set or update (merged with existing)'),
                secureProperties: z
                    .record(z.string())
                    .optional()
                    .describe('Secure (encrypted) properties to set or update (merged with existing)'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ appName, environment, properties, secureProperties }) => {
            try {
                if (Object.keys(properties ?? {}).length + Object.keys(secureProperties ?? {}).length === 0) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'At least one of "properties" or "secureProperties" must be provided.',
                            },
                        ],
                        isError: true,
                    };
                }

                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const detail = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!detail) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                const merged = mergeApplicationProperties(detail, properties, secureProperties);
                await client.cloudHub2.updateApplicationConfiguration(orgId, env.id, detail.id, merged);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    message: `✅ Updated settings for "${appName}" in ${env.name}. Rolling restart triggered.`,
                                    propertiesUpdated: properties ? Object.keys(properties) : [],
                                    securePropertiesUpdated: secureProperties ? Object.keys(secureProperties) : [],
                                    tip: 'Use get_app_status to monitor the restart, and get_app_settings to verify.',
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'delete_app',
        {
            title: 'Delete Application Deployment',
            description:
                'Permanently deletes a CloudHub 2.0 application deployment while leaving its Exchange artifact and other Anypoint resources untouched. This is a bound two-step operation: call without confirm for a preview, then re-call with confirm:true and the exact expectedDeploymentId from that preview. Production also requires confirmProduction:true. Use stop_app instead when the deployment configuration should be preserved.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name or ID'),
                confirm: z.boolean().optional().describe('Set true only after reviewing the dry-run preview.'),
                expectedDeploymentId: z
                    .string()
                    .optional()
                    .describe(
                        'Exact deployment ID returned by the dry-run preview; binds confirmation to one deployment.',
                    ),
                confirmProduction: z
                    .boolean()
                    .optional()
                    .describe('Required in addition to confirm:true when the resolved environment is production.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ appName, environment, confirm, expectedDeploymentId, confirmProduction }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!deployment) {
                    if (confirm && expectedDeploymentId) {
                        return mcpText({
                            deleted: false,
                            alreadyAbsent: true,
                            verifiedAbsent: true,
                            app: appName,
                            environment: env.name,
                            expectedDeploymentId,
                        });
                    }
                    return {
                        ...mcpText({ message: `Application "${appName}" not found in ${env.name}` }),
                        isError: true as const,
                    };
                }

                const preview = buildApplicationDeletionPreview(deployment, env);

                if (!confirm) {
                    return dryRunPreview({
                        ...preview,
                        confirmation: {
                            confirm: true,
                            expectedDeploymentId: deployment.id,
                            ...(preview.production ? { confirmProduction: true } : {}),
                        },
                    });
                }

                if (!deploymentIdMatches(expectedDeploymentId, deployment.id)) {
                    return {
                        ...mcpText({
                            message:
                                'Deletion refused: expectedDeploymentId is missing or does not match the current deployment.',
                            expectedDeploymentId: expectedDeploymentId ?? null,
                            currentDeploymentId: deployment.id,
                            app: deployment.name,
                            environment: env.name,
                        }),
                        isError: true as const,
                    };
                }

                if (preview.production && !confirmProduction) {
                    return {
                        ...mcpText({
                            message: 'Deletion refused: production requires confirmProduction:true.',
                            app: deployment.name,
                            environment: env.name,
                            deploymentId: deployment.id,
                        }),
                        isError: true as const,
                    };
                }

                await client.cloudHub2.deleteDeployment(orgId, env.id, deployment.id);
                const verification = await client.cloudHub2.waitForDeploymentDeletion(
                    orgId,
                    env.id,
                    deployment.name,
                    deployment.id,
                );

                if (verification.replacementDeploymentId) {
                    return {
                        ...mcpText({
                            deletionAccepted: true,
                            verifiedAbsent: false,
                            replacementDetected: true,
                            deletedDeploymentId: deployment.id,
                            replacementDeploymentId: verification.replacementDeploymentId,
                            message:
                                'The original deployment was deleted, but a new deployment now uses the same name.',
                        }),
                        isError: true as const,
                    };
                }

                if (!verification.verifiedAbsent) {
                    return mcpText({
                        deletionAccepted: true,
                        verifiedAbsent: false,
                        ...(verification.deletionState ? { deletionState: verification.deletionState } : {}),
                        deploymentId: deployment.id,
                        app: deployment.name,
                        environment: env.name,
                        message: verification.deletionState
                            ? 'CloudHub marks the deployment as DELETED, but its tombstone remains visible in the list.'
                            : 'CloudHub accepted deletion, but absence was not verified within 60 seconds.',
                    });
                }

                return mcpText({
                    deleted: true,
                    verifiedAbsent: true,
                    deploymentId: deployment.id,
                    app: deployment.name,
                    environment: env.name,
                    preserved: preview.preserved,
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'stop_app',
        {
            title: 'Stop Application',
            description:
                "Stops a running Mule application in CloudHub 2.0 without deleting the deployment. The application's replicas are terminated but the deployment configuration is preserved. Use this to temporarily take an app offline for maintenance, cost savings, or to prevent traffic during investigations. Use start_app to bring it back online.",
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ appName, environment }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                await client.cloudHub2.setDesiredState(orgId, env.id, deployment.id, 'STOPPED');

                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Stop initiated for "${appName}" in ${env.name}. Replicas will be terminated. Use get_app_status to monitor, and start_app to bring it back online.`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'start_app',
        {
            title: 'Start Application',
            description:
                'Starts a stopped Mule application in CloudHub 2.0. Brings the application back online by requesting the desired state to STARTED. Use this after stop_app to resume processing, or to recover an app that was manually stopped.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({ appName, environment }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                await client.cloudHub2.setDesiredState(orgId, env.id, deployment.id, 'STARTED');

                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Start initiated for "${appName}" in ${env.name}. Use get_app_status to monitor replica startup.`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
