/**
 * MCP Tool Registrar — Application lifecycle tools (production-guarded)
 * restart_app, scale_app, stop_app, start_app, update_app_settings, delete_app
 *
 * Every tool here previews by default and applies on confirm: true; production also needs
 * confirmProduction: true.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import type { CH2Deployment } from '../../api/CloudHub2Api.js';
import { mcpError, mcpText, dryRunPreview, guardWrite, resolveEnvironment, writeInputs } from './shared.js';
import { modeInput, runAppChangeTool, settingsFromArgs, settingsInputs, waitInputs } from './app-inputs.js';
import { buildApplicationDeletionPreview, deploymentIdMatches } from '../../safety/deletion.js';
import { deploymentPhase, waitForAppPhase } from '../../workflows/app-state.js';

const appInputs = {
    appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
    environment: z.string().describe('Environment name or ID'),
};

function notFound(appName: string, envName: string) {
    return { ...mcpText({ message: `Application "${appName}" not found in ${envName}` }), isError: true as const };
}

/**
 * Apply a narrow state change (stop, start, scale), then optionally wait for it to settle.
 */
async function runStateChange(
    client: AnypointClient,
    args: {
        appName: string;
        environment: string;
        confirm?: boolean;
        confirmProduction?: boolean;
        wait?: boolean;
        waitTimeoutSeconds?: number;
    },
    describe: (detail: CH2Deployment) => Record<string, unknown> | string,
    apply: (orgId: string, envId: string, detail: CH2Deployment) => Promise<unknown>,
) {
    try {
        const { orgId, env } = await resolveEnvironment(client, args.environment);
        const detail = await client.cloudHub2.findDetailByName(orgId, env.id, args.appName);
        if (!detail) return notFound(args.appName, env.name);

        const described = describe(detail);
        if (typeof described === 'string') return mcpText({ noop: true, message: described });
        const preview = {
            app: detail.name,
            environment: env.name,
            current: {
                desiredState: detail.application.desiredState,
                replicas: detail.target?.replicas,
                phase: deploymentPhase(detail).phase,
            },
            ...described,
        };
        const gate = guardWrite({ env, confirm: args.confirm, confirmProduction: args.confirmProduction, preview });
        if (gate) return gate;

        const sentAt = Date.now();
        await apply(orgId, env.id, detail);
        if (!args.wait) {
            return mcpText({
                ...preview,
                applied: true,
                tip: 'Pass wait: true, or call get_app_status with wait: true, to follow it.',
            });
        }
        const result = await waitForAppPhase(client.cloudHub2, orgId, env.id, detail.id, {
            sinceChange: sentAt,
            timeoutMs: args.waitTimeoutSeconds ? args.waitTimeoutSeconds * 1000 : undefined,
        });
        const response = mcpText({
            ...preview,
            applied: true,
            phase: result.snapshot.phase,
            settled: result.snapshot.settled,
            ...(result.snapshot.reason ? { reason: result.snapshot.reason } : {}),
            ...(result.timedOut ? { timedOut: true } : {}),
        });
        return result.snapshot.terminal && !result.snapshot.settled
            ? { ...response, isError: true as const }
            : response;
    } catch (error) {
        return mcpError(error);
    }
}

export function registerAppLifecycleTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'restart_app',
        {
            title: 'Restart Application',
            description:
                'Restarts a CloudHub 2.0 application by stopping it, waiting until every replica is down, and starting it again, so old and new replicas never run together. Expect a short outage. Use when an app misbehaves (memory pressure, stale connections) and no new version is needed. Previews by default; pass confirm: true to apply.',
            inputSchema: { ...appInputs, ...waitInputs, ...writeInputs },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async (args) => runAppChangeTool(client, args, { restart: true, mode: 'stopStart' }, { done: 'Restarted' }),
    );

    server.registerTool(
        'scale_app',
        {
            title: 'Scale Application',
            description:
                'Changes the number of replicas of a CloudHub 2.0 application. New replicas receive traffic once their health checks pass. Previews by default; pass confirm: true to apply.',
            inputSchema: {
                ...appInputs,
                replicas: z.number().min(1).max(8).describe('Desired number of replicas (1-8)'),
                ...waitInputs,
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async (args) =>
            runStateChange(
                client,
                args,
                (detail) =>
                    detail.target?.replicas === args.replicas
                        ? `"${detail.name}" already runs ${args.replicas} replica(s)`
                        : { action: 'scale', next: { replicas: args.replicas } },
                (orgId, envId, detail) => client.cloudHub2.scaleApp(orgId, envId, detail.id, args.replicas),
            ),
    );

    server.registerTool(
        'stop_app',
        {
            title: 'Stop Application',
            description:
                'Stops a CloudHub 2.0 application without deleting it: replicas terminate and the deployment configuration is kept. Use start_app to bring it back. Previews by default; pass confirm: true to apply.',
            inputSchema: { ...appInputs, ...waitInputs, ...writeInputs },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async (args) =>
            runStateChange(
                client,
                args,
                (detail) =>
                    detail.application.desiredState === 'STOPPED'
                        ? `"${detail.name}" is already stopped`
                        : { action: 'stop', next: { desiredState: 'STOPPED' } },
                (orgId, envId, detail) => client.cloudHub2.setDesiredState(orgId, envId, detail.id, 'STOPPED'),
            ),
    );

    server.registerTool(
        'start_app',
        {
            title: 'Start Application',
            description:
                'Starts a stopped CloudHub 2.0 application. With wait: true it returns once every replica is running, without reporting the brief FAILED status the platform shows during start-up. Previews by default; pass confirm: true to apply.',
            inputSchema: { ...appInputs, ...waitInputs, ...writeInputs },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async (args) =>
            runStateChange(
                client,
                args,
                (detail) =>
                    detail.application.desiredState === 'STARTED' && deploymentPhase(detail).settled
                        ? `"${detail.name}" is already running`
                        : { action: 'start', next: { desiredState: 'STARTED' } },
                (orgId, envId, detail) => client.cloudHub2.setDesiredState(orgId, envId, detail.id, 'STARTED'),
            ),
    );

    server.registerTool(
        'update_app_settings',
        {
            title: 'Update Application Settings',
            description:
                'Adds, changes, removes or moves application properties of a CloudHub 2.0 app. Untouched properties are kept; stored secure values are kept too, because the platform retains a secure value whenever it is sent back masked. ' +
                'Pass secrets through securePropertiesFrom (a project file or environment variables read on the server) so they never appear in the conversation, and use moveToSecure to turn a plain property into a secure one without exposing its value. ' +
                'The app references secure properties as plain ${key}. Applying restarts the app; use mode stopStart for apps with streaming or polling listeners. Previews by default; pass confirm: true to apply.',
            inputSchema: { ...appInputs, ...settingsInputs, mode: modeInput, ...waitInputs, ...writeInputs },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async (args) => {
            const settings = settingsFromArgs(args);
            const empty = Object.values(settings).every(
                (value) =>
                    value === undefined ||
                    (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0),
            );
            if (empty) {
                return {
                    ...mcpText({
                        message:
                            'Nothing to change: pass properties, secureProperties, propertiesFrom, securePropertiesFrom, removeProperties, removeSecureProperties or moveToSecure.',
                    }),
                    isError: true as const,
                };
            }
            return runAppChangeTool(client, args, { settings, mode: args.mode }, { done: 'Updated settings of' });
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
