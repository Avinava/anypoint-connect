/**
 * MCP Tool Registrar — Profile management tools
 * set_project_profile, get_project_profile
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    resolveProfile,
    listProfiles,
    writeProjectConfig,
    discoverProjectConfig,
    hasSavedConfig,
} from '../../utils/config.js';

export function registerProfileTools(server: McpServer) {
    server.registerTool(
        'get_project_profile',
        {
            title: 'Get Project Profile',
            description:
                'Returns the currently active Anypoint profile for this project, how it was resolved (flag, env, project-file, or default), and lists all available profiles. Use this to understand which Anypoint org/credentials are in use.',
            annotations: { readOnlyHint: true },
        },
        async () => {
            const resolved = resolveProfile();
            const profiles = listProfiles();
            const projectConfig = discoverProjectConfig();

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                activeProfile: resolved.name,
                                resolvedVia: resolved.source,
                                projectBinding: projectConfig?.profile || null,
                                availableProfiles: profiles.map((p) => ({
                                    name: p,
                                    hasCredentials: hasSavedConfig(p),
                                    isActive: p === resolved.name,
                                })),
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'set_project_profile',
        {
            title: 'Set Project Profile',
            description:
                'Binds the current project directory to a named Anypoint profile by writing .anypoint-connect.json. After this, all CLI commands and MCP tools run from this directory will automatically use the specified profile.',
            annotations: { readOnlyHint: false },
            inputSchema: {
                profile: z.string().describe('The profile name to bind to this project directory'),
                directory: z
                    .string()
                    .optional()
                    .describe('Directory to write .anypoint-connect.json in (defaults to cwd)'),
            },
        },
        async ({ profile, directory }) => {
            try {
                // Validate profile exists
                const profiles = listProfiles();
                if (profiles.length > 0 && !profiles.includes(profile)) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Warning: Profile "${profile}" does not exist yet. Available profiles: ${profiles.join(', ')}. The binding was created but you'll need to run "anc config init --profile ${profile}" to set up credentials.`,
                            },
                        ],
                    };
                }

                const filePath = writeProjectConfig(profile, directory);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Project bound to profile "${profile}". Config written to: ${filePath}\n\nAll CLI commands and MCP tools in this directory will now use the "${profile}" profile.`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to set project profile: ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
