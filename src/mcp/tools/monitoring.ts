/**
 * MCP Tool Registrar — Monitoring tools
 * get_metrics
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { errorMessage } from '../../utils/errors.js';

export function registerMonitoringTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'get_metrics',
        {
            title: 'Get Application Metrics',
            description:
                'Fetches runtime performance metrics for applications in an environment using Anypoint Monitoring AMQL queries. Returns inbound request count, average response time (ms), error count, outbound request count, and outbound average response time. Use this to identify performance bottlenecks, high error rates, or traffic patterns.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends.'),
                appName: z
                    .string()
                    .optional()
                    .describe('Filter to a specific application name. Omit to get metrics for all apps.'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, appName }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const to = Date.now();
                const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                const metrics = await client.monitoring.getAppMetrics(orgId, env.id, from, to, appName);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                    apps: metrics,
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
