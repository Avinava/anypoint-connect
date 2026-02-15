/**
 * MCP Tool Registrar — Application tools
 * list_apps, get_app_status, restart_app, scale_app
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError } from './shared.js';

export function registerApplicationTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'list_apps',
        {
            title: 'List Applications',
            description:
                'Lists all Mule applications deployed in a CloudHub 2.0 environment. Returns each app\'s name, deployment status (APPLIED, STARTED, FAILED), artifact version, Mule runtime version, and replica count. Accepts environment name (e.g. "Development") or environment ID.',
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
                "Returns detailed deployment information for a specific Mule application: status, artifact version (groupId:artifactId:version), Mule runtime version, each replica's state and deployment location, the public URL, and last update timestamp. Use this to check if an app is healthy before or after a deployment.",
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
}
