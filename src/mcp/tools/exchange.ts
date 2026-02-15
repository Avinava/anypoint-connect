/**
 * MCP Tool Registrar — Exchange tools
 * search_exchange, download_api_spec, compare_environments
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError } from './shared.js';

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
                    client.cloudHub2.getDeployments(orgId, e1.id),
                    client.cloudHub2.getDeployments(orgId, e2.id),
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
                                      replicas: a1.target?.replicas?.length || 0,
                                  }
                                : 'NOT DEPLOYED',
                            [e2.name]: a2
                                ? {
                                      status: a2.status,
                                      version: a2.application?.ref?.version || '-',
                                      replicas: a2.target?.replicas?.length || 0,
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
