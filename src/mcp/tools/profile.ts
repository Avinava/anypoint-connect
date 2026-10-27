/**
 * MCP Tool Registrar — Profile management tools
 * set_project_profile, get_project_profile
 */

import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    resolveProfile,
    listProfiles,
    updateProjectConfig,
    discoverProjectConfig,
    hasSavedConfig,
} from '../../config/profiles.js';
import {
    ALL_MUTATING,
    NAMED_ONLY_TOOLS,
    PREAPPROVABLE_TOOLS,
    readPreapproval,
    validatePreapproval,
    type PreapprovalState,
} from '../../safety/preapproval.js';
import { dryRunPreview, mcpText } from './shared.js';

/** The pre-approval as shown to the agent: names, tools and expiry only. */
export function describePreapproval(state: PreapprovalState) {
    const active = state.entries.filter((e) => !e.expired);
    return {
        active: active.map(({ environments, tools, expires }) => ({
            environments,
            tools,
            ...(expires ? { expires } : {}),
        })),
        ...(state.entries.length > active.length
            ? {
                  expired: state.entries
                      .filter((e) => e.expired)
                      .map(({ environments, expires }) => ({ environments, expires })),
              }
            : {}),
        ...(state.invalid.length ? { invalid: state.invalid } : {}),
        ...(state.source ? { source: state.source } : {}),
    };
}

const preapprovalSchema = z.object({
    environments: z.array(z.string()).min(1).describe('Exact production environment names or IDs (no wildcards)'),
    tools: z
        .union([z.literal(ALL_MUTATING), z.array(z.enum(PREAPPROVABLE_TOOLS)).min(1)])
        .describe(
            `Tool names, or "${ALL_MUTATING}" for every mutating tool except ${NAMED_ONLY_TOOLS.join(', ')} (which must be named)`,
        ),
    expires: z.string().optional().describe('ISO 8601 date-time after which the entry is ignored'),
});

export function registerProfileTools(server: McpServer) {
    server.registerTool(
        'get_project_profile',
        {
            title: 'Get Project Profile',
            description:
                'Returns the currently active Anypoint profile for this project, how it was resolved (flag, env, project-file, or default), lists all available profiles, and shows the production pre-approval of .anypoint-connect.json (environments, tools, expiry). Use this to understand which Anypoint org/credentials are in use and which production writes skip confirmProduction.',
            annotations: { readOnlyHint: true },
        },
        async () => {
            const resolved = resolveProfile();
            const profiles = listProfiles();
            const projectConfig = discoverProjectConfig();

            return mcpText({
                activeProfile: resolved.name,
                resolvedVia: resolved.source,
                projectBinding: projectConfig?.profile || null,
                availableProfiles: profiles.map((p) => ({
                    name: p,
                    hasCredentials: hasSavedConfig(p),
                    isActive: p === resolved.name,
                })),
                productionPreapproval: describePreapproval(readPreapproval()),
            });
        },
    );

    server.registerTool(
        'set_project_profile',
        {
            title: 'Set Project Profile',
            description:
                'Binds the current project directory to a named Anypoint profile by writing .anypoint-connect.json, and sets or clears its production pre-approval. Other fields of the file are kept. ' +
                'A production pre-approval lets the named tools write to the named production environments without confirmProduction (CLI: without the typed phrase) until it expires; confirm: true, bound IDs, digests and refusals still apply. ' +
                'Changing the pre-approval is a guarded config change: it previews by default and is written only with confirm: true. Binding a profile alone is written directly.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            inputSchema: {
                profile: z.string().optional().describe('The profile name to bind to this project directory'),
                directory: z
                    .string()
                    .optional()
                    .describe('Directory to write .anypoint-connect.json in (defaults to cwd)'),
                productionPreapproval: preapprovalSchema
                    .optional()
                    .describe('Replace the production pre-approval with this entry'),
                clearProductionPreapproval: z.boolean().optional().describe('Remove the production pre-approval'),
                confirm: z
                    .boolean()
                    .optional()
                    .describe('Write a pre-approval change. Without it the tool returns a preview and writes nothing'),
            },
        },
        async ({ profile, directory, productionPreapproval, clearProductionPreapproval, confirm }) => {
            try {
                if (!profile && !productionPreapproval && !clearProductionPreapproval) {
                    throw new Error('Pass profile, productionPreapproval or clearProductionPreapproval');
                }
                if (productionPreapproval && clearProductionPreapproval) {
                    throw new Error('Pass productionPreapproval or clearProductionPreapproval, not both');
                }

                const preapprovalChange = productionPreapproval || clearProductionPreapproval;
                if (preapprovalChange) {
                    const entry = productionPreapproval ? validatePreapproval(productionPreapproval) : undefined;
                    const targetDir = directory || process.cwd();
                    const file = path.join(targetDir, '.anypoint-connect.json');
                    const before = describePreapproval(readPreapproval({ startDir: targetDir }));
                    const preview = {
                        action: entry ? 'set production pre-approval' : 'clear production pre-approval',
                        file,
                        ...(profile ? { profile } : {}),
                        current: before.active,
                        next: entry ? [entry] : [],
                    };
                    if (!confirm) return dryRunPreview(preview);
                    updateProjectConfig(
                        {
                            ...(profile ? { profile } : {}),
                            productionPreapproval: entry,
                        },
                        directory,
                    );
                    return mcpText({
                        message: entry ? 'Production pre-approval set.' : 'Production pre-approval cleared.',
                        ...preview,
                        productionPreapproval: describePreapproval(readPreapproval({ startDir: targetDir })),
                    });
                }

                // Validate profile exists
                const profiles = listProfiles();
                const filePath = updateProjectConfig({ profile }, directory);
                if (profiles.length > 0 && !profiles.includes(profile!)) {
                    return mcpText(
                        `Warning: Profile "${profile}" does not exist yet. Available profiles: ${profiles.join(', ')}. The binding was created but you'll need to run "anc config init --profile ${profile}" to set up credentials.`,
                    );
                }

                return mcpText(
                    `Project bound to profile "${profile}". Config written to: ${filePath}\n\nAll CLI commands and MCP tools in this directory will now use the "${profile}" profile.`,
                );
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
