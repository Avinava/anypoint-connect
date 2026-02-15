/**
 * MCP Tool Registrar — API Manager tools
 * list_api_instances, get_api_policies
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { errorMessage } from '../../utils/errors.js';

export function registerApiManagerTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'list_api_instances',
        {
            title: 'List API Instances',
            description:
                "Lists all managed API instances registered in API Manager for an environment. Returns each API's name, instance ID, status (active/inactive), asset version, technology (Mule 3 or 4), endpoint URI, deprecation flag, and active contract count. Use this to review API governance posture or find the API instance ID needed for get_api_policies.",
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const assets = await client.apiManager.getApis(orgId, env.id);

                const instances = assets.flatMap((asset) =>
                    asset.apis.map((api) => ({
                        apiName: asset.exchangeAssetName,
                        apiId: api.id,
                        status: api.status,
                        version: api.assetVersion,
                        technology: api.technology,
                        endpoint: api.endpointUri,
                        deprecated: api.deprecated,
                        contracts: api.activeContractsCount,
                    })),
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ environment: env.name, instances }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error: ${errorMessage(error)}` }],
                    isError: true,
                };
            }
        },
    );

    server.registerTool(
        'get_api_policies',
        {
            title: 'Get API Policies & SLA Tiers',
            description:
                'Returns the full policy chain and SLA tier configuration for a managed API instance. For each policy, shows the template name (e.g. "client-id-enforcement", "rate-limiting"), version, execution order, whether it is disabled, and its configuration. For each SLA tier, shows the name, rate limits, auto-approve setting, and how many client apps have contracted it. Use this to audit API security and rate-limiting configuration.',
            inputSchema: {
                apiName: z
                    .string()
                    .describe('API name (partial match) or numeric API instance ID from list_api_instances'),
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ apiName, environment }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                let apiId: number;
                const numId = parseInt(apiName);
                if (!isNaN(numId)) {
                    apiId = numId;
                } else {
                    const found = await client.apiManager.findByName(orgId, env.id, apiName);
                    if (!found) {
                        return {
                            content: [{ type: 'text', text: `API "${apiName}" not found in ${env.name}` }],
                            isError: true,
                        };
                    }
                    apiId = found.instance.id;
                }

                const [policies, tiers] = await Promise.all([
                    client.apiManager.getPolicies(orgId, env.id, apiId),
                    client.apiManager.getSlaTiers(orgId, env.id, apiId),
                ]);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    apiId,
                                    policies: policies.map((p) => ({
                                        id: p.id,
                                        template: p.template?.assetId || p.policyTemplateId,
                                        version: p.template?.assetVersion,
                                        order: p.order,
                                        disabled: p.disabled,
                                        config: p.configurationData,
                                    })),
                                    slaTiers: tiers.map((t) => ({
                                        name: t.name,
                                        status: t.status,
                                        autoApprove: t.autoApprove,
                                        limits: t.limits,
                                        appCount: t.applicationCount,
                                    })),
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error: ${errorMessage(error)}` }],
                    isError: true,
                };
            }
        },
    );
}
