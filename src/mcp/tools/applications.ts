import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import type { CreateDeploymentPayload } from '../../api/CloudHub2Api.js';
import { mcpError } from './shared.js';

type DeploymentSettings = CreateDeploymentPayload['target']['deploymentSettings'];

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
                const deployments = await client.cloudHub2.getDeployments(orgId, env.id);

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
                                    replicas: d.target?.replicas?.length,
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
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

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
                                    replicas: deployment.target?.replicas?.map((r) => ({
                                        id: r.id,
                                        state: r.state,
                                        location: r.deploymentLocation,
                                    })),
                                    publicUrl: deployment.target?.deploymentSettings?.http?.inbound?.publicUrl,
                                    updatedAt: deployment.updatedAt,
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
                const deployments = await client.cloudHub2.getDeployments(orgId, env.id);

                const resources = deployments.map((d) => ({
                    name: d.name,
                    status: d.status,
                    vCores: d.application?.vCores,
                    cpu: d.target?.deploymentSettings?.resources?.cpu,
                    memory: d.target?.deploymentSettings?.resources?.memory,
                    replicas: d.target?.replicas?.length ?? 0,
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
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                    };
                }

                const detail = await client.cloudHub2.getDeployment(orgId, env.id, deployment.id);

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
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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
        }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const existing = await client.cloudHub2.findByName(orgId, env.id, appName);

                const targetRegion = region || 'cloudhub-us-east-2';

                // Build configuration if properties are provided
                const configuration: Record<string, unknown> = {};
                if (properties || secureProperties) {
                    configuration['mule.agent.application.properties.service'] = {
                        applicationName: appName,
                        ...(properties ? { properties } : {}),
                        ...(secureProperties ? { secureProperties } : {}),
                    };
                }

                const payload: CreateDeploymentPayload = {
                    name: appName,
                    application: {
                        ref: {
                            groupId,
                            artifactId,
                            version,
                            packaging: 'jar',
                        },
                        desiredState: 'STARTED',
                        ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
                    },
                    target: {
                        provider: 'MC',
                        targetId: targetRegion,
                        deploymentSettings: {
                            runtime: { version: runtime || '4.8.0' },
                            http: {
                                inbound: {
                                    publicUrl: `${appName}.${targetRegion.replace('cloudhub-', '').replace(/-/g, '')}.cloudhub.io`,
                                },
                            },
                            clustered: false,
                            enforceDeployingReplicasAcrossNodes: false,
                            updateStrategy: 'rolling',
                            ...(jvmArgs ? { jvm: { args: jvmArgs } } : {}),
                        },
                        replicas: replicas || 1,
                    },
                };

                let deployment;
                let action: string;

                if (existing) {
                    deployment = await client.cloudHub2.updateDeployment(orgId, env.id, existing.id, payload);
                    action = 'Redeployed';
                } else {
                    deployment = await client.cloudHub2.createDeployment(orgId, env.id, payload);
                    action = 'Created new deployment';
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    message: `✅ ${action} for "${appName}" in ${env.name}`,
                                    deploymentId: deployment.id,
                                    status: deployment.status,
                                    version: `${groupId}:${artifactId}:${version}`,
                                    runtime: runtime || '4.8.0',
                                    replicas: replicas || 1,
                                    region: targetRegion,
                                    previousVersion: existing?.application?.ref?.version || null,
                                    tip: 'Use get_app_status to monitor deployment progress.',
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
                if (!properties && !secureProperties) {
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
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                // Fetch current deployment details to merge properties
                const detail = await client.cloudHub2.getDeployment(orgId, env.id, deployment.id);
                const existingConfig = (detail.application?.configuration ?? {}) as Record<string, unknown>;
                const existingService = (existingConfig['mule.agent.application.properties.service'] ?? {}) as Record<
                    string,
                    unknown
                >;
                const existingProps = (existingService.properties ?? {}) as Record<string, string>;
                const existingSecure = (existingService.secureProperties ?? {}) as Record<string, string>;

                const mergedProps = { ...existingProps, ...(properties || {}) };
                const mergedSecure = { ...existingSecure, ...(secureProperties || {}) };

                const runtimeVersion = deployment.target.deploymentSettings?.runtime?.version || '4.8.0';

                await client.cloudHub2.updateDeployment(orgId, env.id, deployment.id, {
                    name: deployment.name,
                    application: {
                        ref: deployment.application.ref,
                        desiredState: 'STARTED',
                        configuration: {
                            'mule.agent.application.properties.service': {
                                applicationName: deployment.name,
                                properties: mergedProps,
                                secureProperties: mergedSecure,
                            },
                        },
                    },
                    target: {
                        provider: 'MC',
                        targetId: deployment.target.targetId,
                        deploymentSettings: {
                            ...deployment.target.deploymentSettings,
                            runtime: { version: runtimeVersion },
                        } as DeploymentSettings,
                    },
                });

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

                const runtimeVersion = deployment.target.deploymentSettings?.runtime?.version || '4.8.0';

                await client.cloudHub2.updateDeployment(orgId, env.id, deployment.id, {
                    name: deployment.name,
                    application: {
                        ref: deployment.application.ref,
                        desiredState: 'STOPPED',
                    },
                    target: {
                        provider: 'MC',
                        targetId: deployment.target.targetId,
                        deploymentSettings: {
                            ...deployment.target.deploymentSettings,
                            runtime: { version: runtimeVersion },
                        } as DeploymentSettings,
                    },
                });

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

                const runtimeVersion = deployment.target.deploymentSettings?.runtime?.version || '4.8.0';

                await client.cloudHub2.updateDeployment(orgId, env.id, deployment.id, {
                    name: deployment.name,
                    application: {
                        ref: deployment.application.ref,
                        desiredState: 'STARTED',
                    },
                    target: {
                        provider: 'MC',
                        targetId: deployment.target.targetId,
                        deploymentSettings: {
                            ...deployment.target.deploymentSettings,
                            runtime: { version: runtimeVersion },
                        } as DeploymentSettings,
                    },
                });

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
