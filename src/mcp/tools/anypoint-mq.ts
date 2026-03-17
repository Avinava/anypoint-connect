/**
 * MCP Tool Registrar — Anypoint MQ tools
 * list_queues, get_queue_stats, get_dlq_messages
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError } from './shared.js';

export function registerAnypointMQTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'list_queues',
        {
            title: 'List Anypoint MQ Destinations',
            description:
                "Lists all Anypoint MQ destinations (queues and exchanges) in an environment and region. Returns each destination's ID, type (queue or exchange), encryption status, dead-letter queue binding, TTL, lock TTL, max delivery attempts, and FIFO flag. Use this to inventory messaging infrastructure or find a specific queue name. Common regions: us-east-1, us-west-2, eu-west-1, ap-southeast-1, ap-southeast-2.",
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                region: z
                    .string()
                    .describe(
                        'MQ region ID (e.g. "us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1", "ap-southeast-2")',
                    ),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, region }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const destinations = await client.anypointMQ.listDestinations(orgId, env.id, region);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ environment: env.name, region, destinations }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_queue_stats',
        {
            title: 'Get MQ Queue Statistics',
            description:
                'Fetches current statistics for an Anypoint MQ queue: messages visible (ready to consume), messages in-flight (being processed), and lifetime totals for sent, received, and acknowledged messages. Use this to monitor queue depth, detect message buildup, or verify consumers are keeping up.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                region: z.string().describe('MQ region ID (e.g. "us-east-1")'),
                queueId: z.string().describe('Queue ID (destination ID) as returned by list_queues'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, region, queueId }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const stats = await client.anypointMQ.getQueueStats(orgId, env.id, region, queueId);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ environment: env.name, region, queue: queueId, stats }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_dlq_messages',
        {
            title: 'Browse Dead-Letter Queue Messages',
            description:
                'Browses messages from an Anypoint MQ dead-letter queue without consuming them. Returns message ID, headers, properties, body content, and creation timestamp. Use this to inspect failed messages for debugging, understand poison-pill patterns, or decide whether messages can be replayed.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                region: z.string().describe('MQ region ID (e.g. "us-east-1")'),
                queueId: z.string().describe('Dead-letter queue ID'),
                batchSize: z.number().optional().describe('Number of messages to retrieve (default: 10, max: 10)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, region, queueId, batchSize }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const messages = await client.anypointMQ.browseMessages(
                    orgId,
                    env.id,
                    region,
                    queueId,
                    batchSize || 10,
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    region,
                                    queue: queueId,
                                    messageCount: messages.length,
                                    messages,
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
