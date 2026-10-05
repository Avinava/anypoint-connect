/**
 * MCP Tool Registrar — Application deployment tools (production-guarded)
 * deploy_jar, deploy_app, update_app_artifact, rollback_app
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError, mcpText, dryRunPreview, resolveEnvironment } from './shared.js';
import { buildCreatePayload, mergeForArtifactUpdate, resolveRollbackTarget } from '../../safety/deployment.js';
import { errorMessage } from '../../utils/errors.js';
import { describeJarDeployment, executeJarDeployment, planJarDeployment } from '../../workflows/jar-deployment.js';

export function registerAppDeployTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'deploy_jar',
        {
            title: 'Deploy JAR (Publish + Deploy)',
            description:
                'One-call deploy of a locally built Mule application JAR: publishes it to Exchange, then deploys it to CloudHub 2.0 — creating the app if it does not exist, or safely updating just the artifact ref if it does. For an existing app, create-only settings (runtime, region, vcores, replicas, jvmArgs, properties) are rejected, because an update must not restate infrastructure. Pass confirm:true to run; without it you get a dry-run preview and nothing is published or deployed.',
            inputSchema: {
                jarPath: z
                    .string()
                    .describe('Path to the built .jar file (e.g. "target/example-api-1.0.0-mule-application.jar")'),
                appName: z.string().describe('CloudHub 2.0 application name'),
                environment: z.string().describe('Environment name (e.g. "Sandbox", "Production") or environment ID'),
                assetId: z
                    .string()
                    .optional()
                    .describe(
                        'Exchange asset ID (also used as the deployment artifactId). Defaults to embedded Maven artifactId.',
                    ),
                assetVersion: z
                    .string()
                    .optional()
                    .describe('Exchange asset and deployment version. Defaults to the embedded Maven version.'),
                groupId: z.string().optional().describe('Exchange/Maven group ID (default: the organization ID).'),
                // create-only settings (rejected when the app already exists)
                runtime: z.string().optional().describe('[new app only] Mule runtime version (default: "4.8.0").'),
                replicas: z
                    .number()
                    .min(1)
                    .max(8)
                    .optional()
                    .describe('[new app only] Number of replicas (default: 1).'),
                region: z
                    .string()
                    .optional()
                    .describe('[new app only] CloudHub 2.0 target region (default: "cloudhub-us-east-2").'),
                vcores: z.string().optional().describe('[new app only] vCore size (default: "0.1").'),
                properties: z.record(z.string()).optional().describe('[new app only] Application properties.'),
                secureProperties: z
                    .record(z.string())
                    .optional()
                    .describe('[new app only] Secure application properties.'),
                jvmArgs: z.string().optional().describe('[new app only] JVM arguments.'),
                wait: z
                    .boolean()
                    .optional()
                    .describe('Wait for the deployment to reach a running state (default: false).'),
                expectedSha256: z
                    .string()
                    .regex(/^[a-fA-F0-9]{64}$/)
                    .optional()
                    .describe('SHA-256 returned by the build or publication preview; rejects changed artifact bytes.'),
                confirm: z
                    .boolean()
                    .optional()
                    .describe('Set true to publish and deploy. When omitted/false, returns a dry-run preview only.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({
            jarPath,
            appName,
            environment,
            assetId,
            assetVersion,
            groupId,
            runtime,
            replicas,
            region,
            vcores,
            properties,
            secureProperties,
            jvmArgs,
            wait,
            expectedSha256,
            confirm,
        }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const plan = await planJarDeployment(client, {
                    jarPath,
                    appName,
                    orgId,
                    env,
                    assetId,
                    assetVersion,
                    groupId,
                    expectedSha256,
                    runtime,
                    replicas,
                    region,
                    vcores,
                    properties,
                    secureProperties,
                    jvmArgs,
                });

                // An update must not restate infra — reject create-only settings for an existing app.
                if (plan.rejectedSettings.length > 0) {
                    return mcpText(
                        `❌ "${appName}" already exists in ${env.name}; deploy_jar updates only the artifact ref and cannot change infrastructure. ` +
                            `Remove these settings (${plan.rejectedSettings.join(', ')}), or use update_app_settings / a fresh deploy to change them.`,
                    );
                }

                if (!confirm) return dryRunPreview(describeJarDeployment(plan));

                const { published, deployment: applied } = await executeJarDeployment(client, plan);
                let deployment = applied;

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
                    message: `✅ Deployed "${appName}" to ${env.name} (${plan.existing ? 'updated' : 'created'})`,
                    published,
                    deploymentId: deployment.id,
                    status: deployment.status,
                    ...(plan.existing ? { previousVersion: plan.existing.application?.ref?.version } : {}),
                    ...(wait ? { waitResult } : { tip: 'Use get_app_status to monitor progress.' }),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

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
                const { orgId, env } = await resolveEnvironment(client, environment);
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
                const { orgId, env } = await resolveEnvironment(client, environment);
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
                const { orgId, env } = await resolveEnvironment(client, environment);
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
}
