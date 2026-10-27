/**
 * MCP Tool Registrar — Audit Log tools
 * get_audit_log
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { ACTOR_CLASSES, classifyAuditEntries } from '../../analysis/audit-actors.js';
import { mcpError, mcpText, timeWindow } from './shared.js';

export function registerAuditTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'get_audit_log',
        {
            title: 'Get Platform Audit Log',
            description:
                'Queries the Anypoint Platform audit log for recent changes: deployments, policy updates, user actions, configuration changes. Returns who did what, when, and to which object. ' +
                `Each entry carries actorClass (${ACTOR_CLASSES.join(', ')}) and the actorRule that matched, and summary.byClass counts the returned entries per class, so platform patches, replica moves and infrastructure patches are not mistaken for a user or pipeline change. ` +
                'An unfiltered query over several days can return more entries than fit in one response; pass objectTypes ["Application"] and mutating actions (e.g. ["Create", "Modify", "Delete"]) to keep it small. ' +
                'Use this to answer "what changed recently?" when troubleshooting issues or for compliance investigations.',
            inputSchema: {
                hoursBack: z.number().optional().describe('How many hours of audit history to retrieve (default: 24)'),
                actions: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'Filter by action types, e.g. ["Create", "Modify", "Delete"]. Omit for all actions (larger responses).',
                    ),
                objectTypes: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'Filter by object types, e.g. ["Application", "API", "Policy", "User"]. Omit for all types; for app changes over several days pass ["Application"].',
                    ),
                limit: z.number().optional().describe('Maximum entries to return (default: 100)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ hoursBack, actions, objectTypes, limit }) => {
            try {
                const orgId = await client.getDefaultOrgId();

                const { period } = timeWindow(hoursBack || 24);

                const result = await client.auditLog.query(orgId, {
                    startDate: period.from,
                    endDate: period.to,
                    actions,
                    objectTypes,
                    limit: limit || 100,
                });
                const { entries, byClass } = classifyAuditEntries(result.data);
                const truncated = result.total > entries.length;

                return mcpText({
                    total: result.total,
                    returned: entries.length,
                    period,
                    summary: { byClass },
                    ...(truncated
                        ? {
                              notice: `${result.total} entries match but ${entries.length} were returned. Narrow with objectTypes ["Application"], mutating actions such as ["Create", "Modify", "Delete"], or a shorter hoursBack.`,
                          }
                        : {}),
                    entries,
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
