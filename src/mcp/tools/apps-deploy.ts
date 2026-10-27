/**
 * MCP Tool Registrar — Application deployment tools (production-guarded)
 * deploy_jar, deploy_app, update_app, update_app_artifact, rollback_app
 *
 * Every tool previews by default and applies on confirm: true; production also needs
 * confirmProduction: true. Changes to an existing app go through one workflow
 * (src/workflows/app-change.ts): one PATCH, a runtime check against the target, and
 * an optional stop, change, start sequence.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { guardWrite, mcpText, productionFields, resolveEnvironment, writeInputs } from './shared.js';
import {
    modeInput,
    provenanceJarInput,
    runAppChangeTool,
    runtimeFromArgs,
    runtimeInputs,
    settingsFromArgs,
    settingsInputs,
    updateStrategyInput,
    waitInputs,
} from './app-inputs.js';
import { buildCreatePayload, resolveRollbackTarget } from '../../safety/deployment.js';
import { redactText } from '../../safety/secrets.js';
import { errorMessage } from '../../utils/errors.js';
import { resolveSettingsInput } from '../../workflows/app-change.js';
import { waitForAppPhase } from '../../workflows/app-state.js';
import { describeJarDeployment, executeJarDeployment, planJarDeployment } from '../../workflows/jar-deployment.js';
import { describeVerification, verifySelectedArtifact } from '../../workflows/artifact-verification.js';

const createOnlyInputs = {
    replicas: z.number().min(1).max(8).optional().describe('[new app only] Number of replicas (default: 1)'),
    region: z.string().optional().describe('[new app only] CloudHub 2.0 target region (default: "cloudhub-us-east-2")'),
    vcores: z
        .string()
        .optional()
        .describe('[new app only] vCore size (default: "0.1"). Options: 0.1, 0.2, 0.5, 1, 1.5, 2, 2.5, 3, 4'),
    jvmArgs: z.string().optional().describe('[new app only] JVM arguments'),
};

const refInputs = {
    artifactId: z.string().optional().describe('Maven artifact ID. Default: keep the current one'),
    groupId: z.string().optional().describe('Maven group ID. Default: keep the current one'),
    packaging: z.string().optional().describe('Artifact packaging. Default: keep the current one (usually "jar")'),
};

function errorText(error: unknown, secretValues: string[]) {
    return {
        content: [{ type: 'text' as const, text: `Error: ${redactText(errorMessage(error), secretValues)}` }],
        isError: true as const,
    };
}

export function registerAppDeployTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'deploy_jar',
        {
            title: 'Deploy JAR (Publish + Deploy)',
            description:
                'Publishes a locally built Mule application JAR to Exchange and deploys it to CloudHub 2.0: creates the app if it does not exist, otherwise updates it in one change (artifact plus any runtime or settings change). ' +
                'Asset coordinates come from explicit inputs, then the project naming convention, then the pattern of the asset the app runs today, then the JAR. ' +
                'Region, vCores, replicas and JVM arguments apply only to a new app. ' +
                'The JAR build marker (META-INF/mule-build/build-info.json) is read. Production takes only a mule-build schemaVersion 1 marker with stripped false and productionDeployable true; a stripped, inconsistent or unreadable marker is refused with no override, and a JAR without a marker is refused unless an unmarked-artifact allowance covers the organization and environment. Elsewhere these are warnings. ' +
                'Previews by default; pass confirm: true to publish and deploy.',
            inputSchema: {
                jarPath: z
                    .string()
                    .describe('Path to the built .jar file (e.g. "target/orders-sapi-1.0.0-mule-application.jar")'),
                appName: z.string().describe('CloudHub 2.0 application name'),
                environment: z.string().describe('Environment name (e.g. "Sandbox") or ID'),
                assetId: z
                    .string()
                    .optional()
                    .describe('Exchange asset ID, also the deployment artifactId. Default: naming convention'),
                assetVersion: z.string().optional().describe('Exchange asset version. Default: naming convention'),
                groupId: z.string().optional().describe('Exchange/Maven group ID (default: the organization ID)'),
                ...runtimeInputs,
                ...createOnlyInputs,
                ...settingsInputs,
                mode: modeInput,
                updateStrategy: updateStrategyInput,
                ...waitInputs,
                expectedSha256: z
                    .string()
                    .regex(/^[a-fA-F0-9]{64}$/)
                    .optional()
                    .describe('SHA-256 from the preview; rejects changed artifact bytes'),
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async (args) => {
            let secretValues: string[] = [];
            try {
                const { orgId, env } = await resolveEnvironment(client, args.environment);
                const plan = await planJarDeployment(client, {
                    jarPath: args.jarPath,
                    appName: args.appName,
                    orgId,
                    env,
                    assetId: args.assetId,
                    assetVersion: args.assetVersion,
                    groupId: args.groupId,
                    expectedSha256: args.expectedSha256,
                    runtime: runtimeFromArgs(args),
                    replicas: args.replicas,
                    region: args.region,
                    vcores: args.vcores,
                    jvmArgs: args.jvmArgs,
                    settings: settingsFromArgs(args),
                    mode: args.mode,
                    updateStrategy: args.updateStrategy,
                });
                secretValues = plan.secretValues;
                const preview = describeJarDeployment(plan);

                if (plan.rejectedSettings.length > 0 || plan.blockers.length) {
                    return {
                        ...mcpText({
                            refused: true,
                            message:
                                plan.rejectedSettings.length > 0
                                    ? `"${args.appName}" already exists in ${env.name}; region, vCores, replicas and JVM arguments apply only to a new app. Remove: ${plan.rejectedSettings.join(', ')}`
                                    : (plan.provenance.blocker ?? 'The change cannot be applied.'),
                            ...preview,
                        }),
                        isError: true as const,
                    };
                }
                const gate = guardWrite({
                    orgId,
                    env,
                    tool: 'deploy_jar',
                    confirm: args.confirm,
                    confirmProduction: args.confirmProduction,
                    preview,
                });
                if (gate) return gate;

                const result = await executeJarDeployment(client, plan, {
                    wait: args.wait,
                    timeoutMs: args.waitTimeoutSeconds ? args.waitTimeoutSeconds * 1000 : undefined,
                });
                const response = mcpText(
                    JSON.parse(
                        redactText(
                            JSON.stringify({
                                message: `Deployed "${args.appName}" to ${env.name} (${plan.existing ? 'updated' : 'created'})`,
                                published: result.published,
                                deploymentId: result.deployment.id,
                                ...productionFields(orgId, env, 'deploy_jar'),
                                ...(plan.existing ? { previousRef: plan.existing.application?.ref } : {}),
                                ...(result.change ? { performed: result.change.performed } : {}),
                                ...(result.snapshot
                                    ? {
                                          phase: result.snapshot.phase,
                                          settled: result.snapshot.settled,
                                          ...(result.snapshot.reason ? { reason: result.snapshot.reason } : {}),
                                          ...(result.timedOut ? { timedOut: true } : {}),
                                      }
                                    : {
                                          tip: 'Pass wait: true, or call get_app_status with wait: true, to follow the rollout.',
                                      }),
                            }),
                            secretValues,
                        ),
                    ),
                );
                return result.snapshot?.terminal && !result.snapshot.settled
                    ? { ...response, isError: true as const }
                    : response;
            } catch (error) {
                return errorText(error, secretValues);
            }
        },
    );

    server.registerTool(
        'deploy_app',
        {
            title: 'Deploy Application',
            description:
                'Deploys an artifact already in Exchange (groupId:artifactId:version) to CloudHub 2.0. Creates the app if it does not exist; otherwise updates it in one change, including any runtime or settings change. ' +
                'Region, vCores, replicas and JVM arguments apply only to a new app. ' +
                'For a production environment the artifact is downloaded from Exchange and its build marker checked first; a jar not marked production deployable, or unmarked without an allowance, is refused. ' +
                'Previews by default; pass confirm: true to apply.',
            inputSchema: {
                appName: z.string().describe('Application name (also the public URL slug)'),
                environment: z.string().describe('Environment name (e.g. "Sandbox") or ID'),
                groupId: z.string().describe('Maven group ID of the artifact (usually the organization ID)'),
                artifactId: z.string().describe('Maven artifact ID (e.g. "orders-sapi")'),
                version: z.string().describe('Artifact version (e.g. "1.2.0")'),
                jarPath: provenanceJarInput,
                ...runtimeInputs,
                ...createOnlyInputs,
                ...settingsInputs,
                mode: modeInput,
                updateStrategy: updateStrategyInput,
                ...waitInputs,
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async (args) => {
            let secretValues: string[] = [];
            try {
                const { orgId, env } = await resolveEnvironment(client, args.environment);
                const existing = await client.cloudHub2.findDetailByName(orgId, env.id, args.appName);

                if (existing) {
                    const rejected = (['region', 'vcores', 'replicas', 'jvmArgs'] as const).filter(
                        (key) => args[key] !== undefined,
                    );
                    if (rejected.length) {
                        return {
                            ...mcpText({
                                refused: true,
                                message: `"${args.appName}" already exists in ${env.name}; ${rejected.join(', ')} apply only to a new app.`,
                            }),
                            isError: true as const,
                        };
                    }
                    return runAppChangeTool(
                        client,
                        args,
                        {
                            existing,
                            ref: { groupId: args.groupId, artifactId: args.artifactId, version: args.version },
                            runtime: runtimeFromArgs(args),
                            settings: settingsFromArgs(args),
                            mode: args.mode,
                            updateStrategy: args.updateStrategy,
                            jarPath: args.jarPath,
                        },
                        { done: 'Updated', tool: 'deploy_app' },
                    );
                }

                const resolved = resolveSettingsInput(settingsFromArgs(args));
                secretValues = resolved.secretValues;
                if (
                    resolved.change?.removeProperties ||
                    resolved.change?.removeSecureProperties ||
                    resolved.change?.moveToSecure
                ) {
                    throw new Error(
                        'removeProperties, removeSecureProperties and moveToSecure apply only to an existing app',
                    );
                }
                const payload = buildCreatePayload({
                    appName: args.appName,
                    groupId: args.groupId,
                    artifactId: args.artifactId,
                    version: args.version,
                    runtime: args.runtime,
                    javaVersion: args.javaVersion,
                    releaseChannel: args.releaseChannel,
                    replicas: args.replicas,
                    region: args.region,
                    vcores: args.vcores,
                    properties: resolved.change?.properties,
                    secureProperties: resolved.change?.secureProperties,
                    jvmArgs: args.jvmArgs,
                });
                const verification = await verifySelectedArtifact(client, {
                    orgId,
                    env,
                    ref: payload.application.ref,
                    jarPath: args.jarPath,
                });
                const preview = {
                    action: 'create new deployment',
                    app: args.appName,
                    environment: env.name,
                    next: {
                        ref: payload.application.ref,
                        runtime: payload.target.deploymentSettings.runtime,
                        region: payload.target.targetId,
                        vCores: payload.application.vCores,
                        replicas: payload.target.replicas,
                        properties: Object.keys(resolved.change?.properties ?? {}),
                        secureProperties: Object.keys(resolved.change?.secureProperties ?? {}),
                    },
                    ...(verification.checked !== 'none' || verification.blockers.length
                        ? { artifactVerification: describeVerification(verification) }
                        : {}),
                    ...(verification.warnings.length ? { warnings: verification.warnings } : {}),
                    ...(verification.blockers.length ? { blockers: verification.blockers } : {}),
                };
                if (verification.blockers.length) {
                    return {
                        ...mcpText({ refused: true, message: verification.blockers[0], ...preview }),
                        isError: true as const,
                    };
                }
                const gate = guardWrite({
                    orgId,
                    env,
                    tool: 'deploy_app',
                    confirm: args.confirm,
                    confirmProduction: args.confirmProduction,
                    preview,
                });
                if (gate) return gate;

                const sentAt = Date.now();
                const deployment = await client.cloudHub2.createDeployment(orgId, env.id, payload);
                if (!args.wait) {
                    return mcpText({
                        message: `Created "${args.appName}" in ${env.name}`,
                        deploymentId: deployment.id,
                        ...productionFields(orgId, env, 'deploy_app'),
                        ...preview.next,
                    });
                }
                const result = await waitForAppPhase(client.cloudHub2, orgId, env.id, deployment.id, {
                    sinceChange: sentAt,
                    timeoutMs: args.waitTimeoutSeconds ? args.waitTimeoutSeconds * 1000 : undefined,
                });
                const response = mcpText({
                    message: `Created "${args.appName}" in ${env.name}`,
                    deploymentId: deployment.id,
                    ...productionFields(orgId, env, 'deploy_app'),
                    phase: result.snapshot.phase,
                    settled: result.snapshot.settled,
                    ...(result.snapshot.reason ? { reason: result.snapshot.reason } : {}),
                    ...(result.timedOut ? { timedOut: true } : {}),
                });
                return result.snapshot.terminal && !result.snapshot.settled
                    ? { ...response, isError: true as const }
                    : response;
            } catch (error) {
                return errorText(error, secretValues);
            }
        },
    );

    server.registerTool(
        'update_app',
        {
            title: 'Update Application',
            description:
                'Changes an existing CloudHub 2.0 application in one call: artifact version, Mule runtime, properties and update strategy together, as one new spec. ' +
                'mode stopStart stops the app, applies the change and starts it, so old and new replicas never process events together; use it for apps with streaming, subscription or polling listeners. ' +
                'The runtime is checked against what the target offers before anything is written; a retired runtime is refused with the nearest supported versions. ' +
                'In production a new artifact is downloaded from Exchange and its build marker checked before anything is written; jarPath also binds the change to a local jar by SHA-256. ' +
                'Waits for the rollout by default. Previews by default; pass confirm: true to apply.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name or ID'),
                version: z.string().optional().describe('New artifact version. Default: keep the current one'),
                ...refInputs,
                jarPath: provenanceJarInput,
                ...runtimeInputs,
                ...settingsInputs,
                mode: modeInput,
                updateStrategy: updateStrategyInput,
                wait: z.boolean().optional().describe('Wait until every replica runs the new spec (default: true)'),
                waitTimeoutSeconds: waitInputs.waitTimeoutSeconds,
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async (args) =>
            runAppChangeTool(
                client,
                { ...args, wait: args.wait ?? true },
                {
                    ref: {
                        version: args.version,
                        artifactId: args.artifactId,
                        groupId: args.groupId,
                        packaging: args.packaging,
                    },
                    runtime: runtimeFromArgs(args),
                    settings: settingsFromArgs(args),
                    mode: args.mode,
                    updateStrategy: args.updateStrategy,
                    jarPath: args.jarPath,
                },
                { done: 'Updated', tool: 'update_app' },
            ),
    );

    server.registerTool(
        'update_app_artifact',
        {
            title: 'Update Application Artifact',
            description:
                'Moves an existing CloudHub 2.0 application to another artifact version, optionally with a runtime change in the same update. Target, replicas, resources and settings are preserved. ' +
                'Use runtime when the current runtime has been retired; the preview names supported versions. For settings changes in the same call use update_app. In production the artifact is downloaded from Exchange and its build marker checked before anything is written; jarPath also binds the change to a local jar by SHA-256. Previews by default; pass confirm: true to apply.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name or ID'),
                version: z.string().describe('New artifact version (e.g. "1.4.12")'),
                ...refInputs,
                jarPath: provenanceJarInput,
                ...runtimeInputs,
                mode: modeInput,
                ...waitInputs,
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async (args) =>
            runAppChangeTool(
                client,
                args,
                {
                    ref: {
                        version: args.version,
                        artifactId: args.artifactId,
                        groupId: args.groupId,
                        packaging: args.packaging,
                    },
                    runtime: runtimeFromArgs(args),
                    mode: args.mode,
                    jarPath: args.jarPath,
                },
                { done: 'Updated artifact of', tool: 'update_app_artifact' },
            ),
    );

    server.registerTool(
        'rollback_app',
        {
            title: 'Roll Back Application',
            description:
                'Rolls an existing CloudHub 2.0 application back to a previous artifact; runtime, target, replicas and settings are preserved. By default it picks the last successful or newest distinct earlier artifact; toVersion selects one. In production the target artifact is downloaded from Exchange and its build marker checked first. Previews by default; pass confirm: true to apply.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                environment: z.string().describe('Environment name or ID'),
                toVersion: z
                    .string()
                    .optional()
                    .describe('Artifact version to roll back to. Default: newest distinct earlier artifact'),
                mode: modeInput,
                ...waitInputs,
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async (args) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, args.environment);
                const existing = await client.cloudHub2.findDetailByName(orgId, env.id, args.appName);
                if (!existing) {
                    return {
                        ...mcpText({ message: `Application "${args.appName}" not found in ${env.name}` }),
                        isError: true as const,
                    };
                }
                const specs = await client.cloudHub2.getDeploymentSpecs(orgId, env.id, existing.id);
                const target = resolveRollbackTarget(existing, specs, args.toVersion);
                if (!target) {
                    return mcpText({
                        noop: true,
                        message: `No distinct rollback target for "${args.appName}" in ${env.name}. Pass toVersion to select one.`,
                    });
                }
                return runAppChangeTool(
                    client,
                    args,
                    { existing, ref: target.ref, mode: args.mode },
                    { done: 'Rolled back', tool: 'rollback_app' },
                );
            } catch (error) {
                return errorText(error, []);
            }
        },
    );
}
