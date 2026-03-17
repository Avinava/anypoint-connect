/**
 * MCP Tool Registrar — Audit Log tools
 * get_audit_log
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError } from './shared.js';

export function registerAuditTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'get_audit_log',
        {
            title: 'Get Platform Audit Log',
            description:
                'Queries the Anypoint Platform audit log for recent changes: deployments, policy updates, user actions, configuration changes. Returns who did what, when, and to which object. Use this to answer "what changed recently?" when troubleshooting issues or for compliance investigations.',
            inputSchema: {
                hoursBack: z.number().optional().describe('How many hours of audit history to retrieve (default: 24)'),
                actions: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'Filter by action types, e.g. ["Login", "Create", "Update", "Delete"]. Omit for all actions.',
                    ),
                objectTypes: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'Filter by object types, e.g. ["Application", "API", "Policy", "User"]. Omit for all types.',
                    ),
                limit: z.number().optional().describe('Maximum entries to return (default: 100)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ hoursBack, actions, objectTypes, limit }) => {
            try {
                const orgId = await client.getDefaultOrgId();

                const endDate = new Date().toISOString();
                const startDate = new Date(Date.now() - (hoursBack || 24) * 60 * 60 * 1000).toISOString();

                const result = await client.auditLog.query(orgId, {
                    startDate,
                    endDate,
                    actions,
                    objectTypes,
                    limit: limit || 100,
                });

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    total: result.total,
                                    period: { from: startDate, to: endDate },
                                    entries: result.data,
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
}
