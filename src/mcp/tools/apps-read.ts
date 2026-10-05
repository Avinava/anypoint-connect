/**
 * MCP Tool Registrar — Application read tools
 * list_apps, get_app_status, get_deployment_spec, get_app_resources, get_app_settings, compare_app_deployments
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError, mcpText } from './shared.js';

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

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ comparison }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
