/**
 * MCP Tool Registrar — API Governance tools
 * explain_api_governance_plan, get_api_governance_conformance
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError } from './shared.js';

export function registerGovernanceTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'explain_api_governance_plan',
        {
            title: 'Explain API Governance Plan',
            description:
                'Reads the centralized governance rulesets that would apply to planned or published API coordinates.',
            inputSchema: {
                groupId: z.string(),
                assetId: z.string(),
                version: z.string().optional(),
                filter: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ groupId, assetId, version, filter }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const ownerId = await client.designCenter.getOwnerId();
                const result = version
                    ? await client.governance.explainPublished(orgId, ownerId, { groupId, assetId, version })
                    : await client.governance.explainPlanned(orgId, ownerId, { groupId, assetId, filter });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_api_governance_conformance',
        {
            title: 'Get API Governance Conformance',
            description:
                'Reads centralized governance conformance for exact API asset versions, filtered by the caller permissions.',
            inputSchema: {
                groupId: z.string(),
                assetId: z.string(),
                minorVersion: z.string(),
                versions: z.array(z.string()).min(1),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ groupId, assetId, minorVersion, versions }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const ownerId = await client.designCenter.getOwnerId();
                const result = await client.governance.conformanceStatus(orgId, ownerId, {
                    orgId,
                    groupId,
                    assetId,
                    minorVersion,
                    versions,
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
