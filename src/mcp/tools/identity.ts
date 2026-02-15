/**
 * MCP Tool Registrar — Identity tools
 * whoami, list_environments
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { errorMessage } from '../../utils/errors.js';
import { mcpError } from './shared.js';

export function registerIdentityTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'whoami',
        {
            title: 'Who Am I',
            description:
                'Returns the currently authenticated Anypoint Platform user, their username, email, organization name, and org ID. Use this first to confirm authentication is working and to obtain the org context needed by other tools.',
            annotations: { readOnlyHint: true },
        },
        async () => {
            try {
                const me = await client.whoami();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    user: `${me.firstName} ${me.lastName}`,
                                    username: me.username,
                                    email: me.email,
                                    organization: me.organization.name,
                                    orgId: me.organization.id,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Auth error: ${errorMessage(error)}. Run "anc auth login" first.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );

    server.registerTool(
        'list_environments',
        {
            title: 'List Environments',
            description:
                "Lists all Anypoint environments in the organization (e.g. Development, Sandbox, Production). Returns each environment's ID, name, type, and whether it is marked as production. Use this to discover available environments before querying apps, logs, or metrics.",
            annotations: { readOnlyHint: true },
        },
        async () => {
            try {
                const orgId = await client.getDefaultOrgId();
                const envs = await client.accessManagement.getEnvironments(orgId);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                envs.map((e) => ({
                                    id: e.id,
                                    name: e.name,
                                    type: e.type,
                                    isProduction: e.isProduction,
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
}
