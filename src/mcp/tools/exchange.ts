/**
 * MCP Tool Registrar — Exchange tools
 * search_exchange, get_exchange_asset, download_api_spec, publish_app_jar
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError, mcpText, dryRunPreview } from './shared.js';
import { readFile } from 'node:fs/promises';
import { inspectArtifact, verifyArtifactDigest } from '../../safety/artifact.js';
import { validateJarFile } from '../../safety/guards.js';

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
                    .describe(
                        'Exchange asset ID. Defaults to the embedded Maven artifactId; explicit publication mappings are preserved.',
                    ),
                assetVersion: z
                    .string()
                    .optional()
                    .describe('Exchange asset version. Defaults to the embedded Maven version.'),
                groupId: z.string().optional().describe('Exchange group ID (default: the organization ID).'),
                expectedSha256: z
                    .string()
                    .regex(/^[a-fA-F0-9]{64}$/)
                    .optional()
                    .describe('SHA-256 returned by the build or publication preview; rejects changed artifact bytes.'),
                confirm: z
                    .boolean()
                    .optional()
                    .describe('Set true to upload. When omitted/false, returns a dry-run preview and uploads nothing.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({ jarPath, assetId, assetVersion, groupId, expectedSha256, confirm }) => {
            try {
                const check = validateJarFile(jarPath);
                if (!check.valid) {
                    return mcpText(`❌ ${check.error}`);
                }

                const orgId = await client.getDefaultOrgId();
                const resolvedGroupId = groupId || orgId;
                const bytes = await readFile(jarPath);
                const artifact = inspectArtifact(bytes, undefined, Boolean(assetId && assetVersion));
                verifyArtifactDigest(bytes, expectedSha256);
                const resolvedAssetId = assetId || artifact.coordinates?.artifactId;
                const resolvedVersion = assetVersion || artifact.coordinates?.version;
                if (!resolvedAssetId || !resolvedVersion) {
                    throw new Error('Embedded Maven identity is unavailable; supply explicit assetId and assetVersion');
                }

                if (!confirm) {
                    return dryRunPreview({
                        action: 'publish app jar to Exchange',
                        jarPath,
                        artifact,
                        expectedSha256: artifact.sha256,
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
                    artifact.sha256,
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
}
