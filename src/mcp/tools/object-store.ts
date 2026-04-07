/**
 * MCP Tool Registrar — Object Store v2 tools
 * list_stores, get_store_keys, get_store_value
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError } from './shared.js';

export function registerObjectStoreTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'list_stores',
        {
            title: 'List Object Stores',
            description:
                "Lists all Object Store v2 stores in an environment. Returns each store's ID, whether it is the default store, TTL settings, and persistence flag. Use this to discover which object stores exist for an environment before inspecting keys or values.",
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const stores = await client.objectStore.listStores(orgId, env.id);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ environment: env.name, stores }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_store_keys',
        {
            title: 'List Object Store Keys',
            description:
                'Lists keys in an Object Store v2 store. Returns an array of key names with optional pagination. Use this to browse stored data, check if a specific key exists, or understand what an application is persisting.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                storeId: z.string().describe('Object store ID as returned by list_stores'),
                startKey: z.string().optional().describe('Pagination cursor — start listing after this key'),
                limit: z.number().optional().describe('Maximum number of keys to return (default: 25)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, storeId, startKey, limit }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const result = await client.objectStore.listKeys(orgId, env.id, storeId, {
                    startKey,
                    limit,
                });

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ environment: env.name, storeId, ...result }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_store_value',
        {
            title: 'Get Object Store Value',
            description:
                'Retrieves a single value from an Object Store v2 store by key. Returns the key, stored value (auto-formatted if JSON), and content type. Use this to inspect cached data, watermarks, idempotency records, or any application state persisted in Object Store.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                storeId: z.string().describe('Object store ID'),
                key: z.string().describe('The key to retrieve'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, storeId, key }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const entry = await client.objectStore.getValue(orgId, env.id, storeId, key);

                // Try to pretty-print JSON values
                let displayValue = entry.value;
                try {
                    const parsed = JSON.parse(entry.value);
                    displayValue = JSON.stringify(parsed, null, 2);
                } catch {
                    // Not JSON, keep raw
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    storeId,
                                    key: entry.key,
                                    contentType: entry.contentType,
                                    value: displayValue,
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
        'put_store_value',
        {
            title: 'Write Object Store Value',
            description:
                'Creates or updates a value in an Object Store v2 store. If the key already exists, its value is overwritten. Use this to set watermarks, update cached data, write idempotency records, or seed test data in Object Store. The value should be a string (use JSON.stringify for structured data).',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                storeId: z.string().describe('Object store ID as returned by list_stores'),
                key: z.string().describe('The key to write'),
                value: z.string().describe('The value to store (string or JSON-stringified object)'),
                contentType: z
                    .string()
                    .optional()
                    .describe(
                        'Content type of the value (default: "application/json"). Use "text/plain" for raw strings.',
                    ),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ environment, storeId, key, value, contentType }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                await client.objectStore.putValue(orgId, env.id, storeId, key, value, contentType);

                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Wrote key "${key}" to store "${storeId}" in ${env.name}. Use get_store_value to verify.`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'delete_store_value',
        {
            title: 'Delete Object Store Key',
            description:
                'Deletes a specific key and its value from an Object Store v2 store. The deletion is permanent and cannot be undone. Use this to remove stale watermarks, clear cached data, or clean up test entries.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                storeId: z.string().describe('Object store ID as returned by list_stores'),
                key: z.string().describe('The key to delete'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({ environment, storeId, key }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                await client.objectStore.deleteKey(orgId, env.id, storeId, key);

                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Deleted key "${key}" from store "${storeId}" in ${env.name}.`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
