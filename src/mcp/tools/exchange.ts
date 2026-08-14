/**
 * MCP Tool Registrar — Exchange tools
 * search_exchange, download_api_spec, compare_environments, get_exchange_asset,
 * publish_app_jar, deploy_jar
 */

import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError, mcpText, dryRunPreview } from './shared.js';
import { validateJarFile } from '../../safety/guards.js';
import { buildCreatePayload, mergeForArtifactUpdate } from '../../safety/deployment.js';
import { errorMessage } from '../../utils/errors.js';

export function registerExchangeTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'search_exchange',
        {
            title: 'Search Exchange',
            description:
                'Searches Anypoint Exchange for reusable assets: API specifications (RAML, OAS), connectors, integration templates, examples, and policies. Returns matching asset names, IDs, types, versions, and descriptions. Use this to discover existing APIs before building new integrations, find connector availability, or locate example projects.',
            inputSchema: {
                query: z
                    .string()
                    .optional()
                    .describe('Search keyword (e.g. "order", "salesforce", "kafka"). Omit to list all assets.'),
                type: z
                    .string()
                    .optional()
                    .describe(
                        'Filter by asset type: rest-api, soap-api, http-api, raml-fragment, app, connector, template, example, policy, custom',
                    ),
                limit: z.number().optional().describe('Maximum number of results to return (default: 20)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ query, type, limit }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const assets = await client.exchange.searchAssets(orgId, {
                    search: query,
                    type,
                    limit: limit || 20,
                });

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                assets.map((a) => ({
                                    name: a.name,
                                    assetId: a.assetId,
                                    groupId: a.groupId,
                                    type: a.type,
                                    version: a.version,
                                    description: a.description,
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
        'download_api_spec',
        {
            title: 'Download API Specification',
            description:
                'Downloads the API specification file (RAML or OAS/Swagger) for an Exchange asset. Returns the raw spec content as text, along with the classifier (e.g. "raml", "oas", "fat-raml") and filename. Use this to inspect API contracts, generate scaffolding, or understand an API\'s endpoints and data models before building an integration.',
            inputSchema: {
                groupId: z.string().describe('Group ID of the asset (typically the org ID — use whoami to get it)'),
                assetId: z.string().describe('Asset ID as shown in Exchange (e.g. "order-management-api")'),
                version: z
                    .string()
                    .optional()
                    .describe('Specific version (e.g. "1.2.0"). Omit to download the latest published version.'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ groupId, assetId, version }) => {
            try {
                const spec = await client.exchange.downloadSpec(groupId, assetId, version);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Classifier: ${spec.classifier}\nFile: ${spec.fileName}\n\n${spec.content}`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'compare_environments',
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

    server.registerTool(
        'get_exchange_asset',
        {
            title: 'Get Exchange Asset Details',
            description:
                "Returns detailed information about a specific Exchange asset including all published versions, dependencies, API instances, contact information, and file classifiers. Use this to check which versions of an asset are available before deploying, to understand an asset's dependency chain, or to find the groupId needed for deploy_app.",
            inputSchema: {
                groupId: z.string().describe('Group ID of the asset (typically the org ID — use whoami to get it)'),
                assetId: z.string().describe('Asset ID as shown in Exchange (e.g. "order-management-api")'),
                version: z
                    .string()
                    .optional()
                    .describe(
                        'Specific version to get details for. Omit to get the latest version with all version history.',
                    ),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ groupId, assetId, version }) => {
            try {
                const detail = await client.exchange.getAsset(groupId, assetId, version);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    name: detail.name,
                                    groupId: detail.groupId,
                                    assetId: detail.assetId,
                                    version: detail.version,
                                    type: detail.type,
                                    description: detail.description,
                                    status: detail.status,
                                    contact: detail.contactName
                                        ? { name: detail.contactName, email: detail.contactEmail }
                                        : null,
                                    versions: detail.versions,
                                    dependencies: detail.dependencies,
                                    instances: detail.instances,
                                    files: detail.files?.map((f) => ({
                                        classifier: f.classifier,
                                        packaging: f.packaging,
                                        mainFile: f.mainFile,
                                    })),
                                    labels: detail.labels,
                                    categories: detail.categories,
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
        'publish_app_jar',
        {
            title: 'Publish Application JAR to Exchange',
            description:
                'Uploads a locally built Mule application JAR to Anypoint Exchange as a type "app" asset, using the Exchange v2 publication API (multipart, classifier mule-application). This is the missing first step for deploying a freshly built artifact: CloudHub 2.0 deployments reference an artifact already in Exchange, and this tool puts it there. Returns the published coordinates (groupId, assetId, version) ready to feed into deploy_app / update_app_artifact. Destructive: publishing a version that already exists may be rejected by Exchange. Pass confirm:true to upload.',
            inputSchema: {
                jarPath: z
                    .string()
                    .describe('Path to the built .jar file (e.g. "target/example-api-1.0.0-mule-application.jar")'),
                assetId: z
                    .string()
                    .optional()
                    .describe('Exchange asset ID. Default: the jar filename without the .jar extension.'),
                assetVersion: z.string().optional().describe('Exchange asset version (default: "1.0.0").'),
                groupId: z.string().optional().describe('Exchange group ID (default: the organization ID).'),
                confirm: z
                    .boolean()
                    .optional()
                    .describe('Set true to upload. When omitted/false, returns a dry-run preview and uploads nothing.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({ jarPath, assetId, assetVersion, groupId, confirm }) => {
            try {
                const check = validateJarFile(jarPath);
                if (!check.valid) {
                    return mcpText(`❌ ${check.error}`);
                }

                const orgId = await client.getDefaultOrgId();
                const resolvedGroupId = groupId || orgId;
                const resolvedAssetId = assetId || path.basename(jarPath).replace(/\.jar$/, '');
                const resolvedVersion = assetVersion || '1.0.0';

                if (!confirm) {
                    return dryRunPreview({
                        action: 'publish app jar to Exchange',
                        jarPath,
                        coordinates: {
                            groupId: resolvedGroupId,
                            assetId: resolvedAssetId,
                            version: resolvedVersion,
                            classifier: 'mule-application',
                        },
                    });
                }

                const result = await client.exchange.publishAppAsset(
                    orgId,
                    resolvedGroupId,
                    resolvedAssetId,
                    resolvedVersion,
                    jarPath,
                );

                return mcpText({
                    message: `✅ Published "${result.assetId}" v${result.version} to Exchange`,
                    coordinates: {
                        groupId: result.groupId,
                        assetId: result.assetId,
                        version: result.version,
                        packaging: 'jar',
                    },
                    tip: 'Deploy it with deploy_app (new app) or update_app_artifact (existing app).',
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

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
                        'Exchange asset ID (also used as the deployment artifactId). Default: jar filename without .jar.',
                    ),
                assetVersion: z
                    .string()
                    .optional()
                    .describe('Exchange asset version and deployment version (default: "1.0.0").'),
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
            confirm,
        }) => {
            try {
                const check = validateJarFile(jarPath);
                if (!check.valid) {
                    return mcpText(`❌ ${check.error}`);
                }

                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const existing = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                const resolvedGroupId = groupId || orgId;
                const resolvedAssetId = assetId || path.basename(jarPath).replace(/\.jar$/, '');
                const resolvedVersion = assetVersion || '1.0.0';

                // An update must not restate infra — reject create-only settings for an existing app.
                if (existing) {
                    const rejected = [
                        runtime && 'runtime',
                        region && 'region',
                        vcores && 'vcores',
                        replicas && 'replicas',
                        jvmArgs && 'jvmArgs',
                        properties && 'properties',
                        secureProperties && 'secureProperties',
                    ].filter(Boolean);
                    if (rejected.length) {
                        return mcpText(
                            `❌ "${appName}" already exists in ${env.name}; deploy_jar updates only the artifact ref and cannot change infrastructure. ` +
                                `Remove these settings (${rejected.join(', ')}), or use update_app_settings / a fresh deploy to change them.`,
                        );
                    }
                }

                const ref = {
                    groupId: resolvedGroupId,
                    artifactId: resolvedAssetId,
                    version: resolvedVersion,
                    packaging: 'jar',
                };
                const action = existing ? 'publish + update artifact ref' : 'publish + create deployment';

                if (!confirm) {
                    return dryRunPreview({
                        action,
                        app: appName,
                        environment: env.name,
                        publish: {
                            groupId: resolvedGroupId,
                            assetId: resolvedAssetId,
                            version: resolvedVersion,
                            classifier: 'mule-application',
                        },
                        deploy: existing
                            ? {
                                  mode: 'update',
                                  from: existing.application?.ref,
                                  to: ref,
                                  preserved: 'runtime, target/space, replicas, resources, settings',
                              }
                            : {
                                  mode: 'create',
                                  ref,
                                  runtime: runtime || '4.8.0',
                                  region: region || 'cloudhub-us-east-2',
                                  vcores: vcores || '0.1',
                                  replicas: replicas || 1,
                              },
                    });
                }

                // 1) Publish the jar to Exchange.
                const published = await client.exchange.publishAppAsset(
                    orgId,
                    resolvedGroupId,
                    resolvedAssetId,
                    resolvedVersion,
                    jarPath,
                );

                // 2) Deploy: safe ref-only update for an existing app, full create otherwise.
                let deployment;
                if (existing) {
                    const merged = mergeForArtifactUpdate(existing, ref);
                    deployment = await client.cloudHub2.updateArtifactRef(
                        orgId,
                        env.id,
                        existing.id,
                        merged.application.ref,
                    );
                } else {
                    const payload = buildCreatePayload({
                        appName,
                        groupId: resolvedGroupId,
                        artifactId: resolvedAssetId,
                        version: resolvedVersion,
                        runtime,
                        replicas,
                        region,
                        vcores,
                        properties,
                        secureProperties,
                        jvmArgs,
                    });
                    deployment = await client.cloudHub2.createDeployment(orgId, env.id, payload);
                }

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
                    message: `✅ Deployed "${appName}" to ${env.name} (${existing ? 'updated' : 'created'})`,
                    published: {
                        groupId: published.groupId,
                        assetId: published.assetId,
                        version: published.version,
                    },
                    deploymentId: deployment.id,
                    status: deployment.status,
                    ...(existing ? { previousVersion: existing.application?.ref?.version } : {}),
                    ...(wait ? { waitResult } : { tip: 'Use get_app_status to monitor progress.' }),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
