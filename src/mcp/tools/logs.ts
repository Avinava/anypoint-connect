/**
 * MCP Tool Registrar — Log tools
 * get_logs, download_logs
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import type { LogEntry } from '../../api/LogsApi.js';
import { mcpError } from './shared.js';

export function registerLogTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'get_logs',
        {
            title: 'Get Application Logs',
            description:
                "Fetches the most recent log entries from a running Mule application. Returns timestamps, log levels (ERROR, WARN, INFO, DEBUG), and messages. Useful for quickly checking an app's current state, spotting recent errors, or verifying a deployment succeeded. For large time-range downloads, use download_logs instead.",
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                lines: z
                    .number()
                    .optional()
                    .describe('Number of most recent log entries to return (default: 100, max: 1000)'),
                level: z
                    .string()
                    .optional()
                    .describe(
                        'Minimum log level filter: ERROR, WARN, INFO, or DEBUG. Only entries at or above this level are returned.',
                    ),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, lines, level }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const entries = await client.logs.getLogs(orgId, env.id, appName, {
                    limit: lines || 100,
                    level,
                });

                const formatted = entries.map((e: LogEntry) => ({
                    timestamp: new Date(e.timestamp).toISOString(),
                    level: e.priority,
                    message: e.message,
                }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ total: entries.length, entries: formatted }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'download_logs',
        {
            title: 'Download Logs for Time Range',
            description:
                'Downloads the full application log file and filters it to a specific time window. Returns all matching log entries as formatted text lines (timestamp [LEVEL] message). Use this for historical analysis, incident investigation, or exporting logs. For quick recent checks, use get_logs instead.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z
                    .number()
                    .describe(
                        'How many hours of logs to retrieve (e.g. 1 for last hour, 24 for last day, 168 for last week)',
                    ),
                level: z.string().optional().describe('Minimum log level filter: ERROR, WARN, INFO, or DEBUG'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, hoursBack, level }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const to = Date.now();
                const from = to - hoursBack * 60 * 60 * 1000;

                const entries = await client.logs.getLogsForPeriod(orgId, env.id, appName, from, to, level);

                const text = entries
                    .map((e) => {
                        const ts = new Date(e.timestamp).toISOString();
                        return `${ts} [${e.priority}] ${e.message}`;
                    })
                    .join('\n');

                return {
                    content: [
                        {
                            type: 'text',
                            text: text || 'No log entries found for the specified period.',
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
