/**
 * MCP Resource Registrar
 * Registers read-only data resources exposed via anypoint:// URIs
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnypointClient } from '../client/AnypointClient.js';
import type { Cache } from '../client/Cache.js';

export function registerResources(server: McpServer, client: AnypointClient, cache?: Cache) {
    server.registerResource(
        'environments',
        'anypoint://environments',
        {
            description: 'List of all Anypoint environments with their IDs, names, types, and production flags',
            mimeType: 'application/json',
        },
        async (uri) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const envs = await client.accessManagement.getEnvironments(orgId);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            text: JSON.stringify(envs, null, 2),
                            mimeType: 'application/json',
                        },
                    ],
                };
            } catch {
                return { contents: [{ uri: uri.href, text: '[]', mimeType: 'application/json' }] };
            }
        },
    );

    if (cache) {
        server.registerResource(
            'cache-stats',
            'anypoint://diagnostics/cache',
            {
                description:
                    'Internal cache statistics: current size, hit/miss counts, eviction count, and hit rate. Useful for diagnosing performance and verifying cache effectiveness.',
                mimeType: 'application/json',
            },
            async (uri) => ({
                contents: [
                    {
                        uri: uri.href,
                        text: JSON.stringify(cache.stats(), null, 2),
                        mimeType: 'application/json',
                    },
                ],
            }),
        );
    }
}
