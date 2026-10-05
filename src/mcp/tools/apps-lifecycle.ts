/**
 * MCP Tool Registrar — Application lifecycle tools (production-guarded)
 * restart_app, scale_app, stop_app, start_app, update_app_settings, delete_app
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError, mcpText, dryRunPreview, resolveEnvironment } from './shared.js';
import { mergeApplicationProperties } from '../../safety/deployment.js';
import { buildApplicationDeletionPreview, deploymentIdMatches } from '../../safety/deletion.js';

export function registerAppLifecycleTools(server: McpServer, client: AnypointClient) {
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
                const { orgId, env } = await resolveEnvironment(client, environment);
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                await client.cloudHub2.restartApp(orgId, env.id, deployment.id);
                return mcpText(
                    `✅ Rolling restart initiated for "${appName}" in ${env.name}. Use get_app_status to monitor progress.`,
                );
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
                const { orgId, env } = await resolveEnvironment(client, environment);
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                await client.cloudHub2.scaleApp(orgId, env.id, deployment.id, replicas);
                return mcpText(
                    `✅ Scaled "${appName}" to ${replicas} replica(s) in ${env.name}. Use get_app_status to monitor.`,
                );
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    // ── New tools ─────────────────────────────────────────

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
                const { orgId, env } = await resolveEnvironment(client, environment);
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                await client.cloudHub2.setDesiredState(orgId, env.id, deployment.id, 'STOPPED');

                return mcpText(
                    `✅ Stop initiated for "${appName}" in ${env.name}. Replicas will be terminated. Use get_app_status to monitor, and start_app to bring it back online.`,
                );
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
                const { orgId, env } = await resolveEnvironment(client, environment);
                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                await client.cloudHub2.setDesiredState(orgId, env.id, deployment.id, 'STARTED');

                return mcpText(
                    `✅ Start initiated for "${appName}" in ${env.name}. Use get_app_status to monitor replica startup.`,
                );
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

                const { orgId, env } = await resolveEnvironment(client, environment);
                const detail = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!detail) {
                    return {
                        content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }],
                        isError: true,
                    };
                }

                const merged = mergeApplicationProperties(detail, properties, secureProperties);
                await client.cloudHub2.updateApplicationConfiguration(orgId, env.id, detail.id, merged);

                return mcpText({
                    message: `✅ Updated settings for "${appName}" in ${env.name}. Rolling restart triggered.`,
                    propertiesUpdated: properties ? Object.keys(properties) : [],
                    securePropertiesUpdated: secureProperties ? Object.keys(secureProperties) : [],
                    tip: 'Use get_app_status to monitor the restart, and get_app_settings to verify.',
                });
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
                const { orgId, env } = await resolveEnvironment(client, environment);
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
}
