/**
 * MCP Tool Registrar — Profile and production policy tools
 * get_project_profile, set_project_profile, set_production_preapproval, set_unmarked_artifact_allowance
 *
 * Production pre-approvals and unmarked-artifact allowances live only in the user-level store
 * (src/safety/preapproval.ts), bound to organization and environment IDs. Project files cannot
 * grant them.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import {
    resolveProfile,
    listProfiles,
    writeProjectConfig,
    discoverProjectConfig,
    hasSavedConfig,
} from '../../config/profiles.js';
import { isProductionEnv } from '../../safety/guards.js';
import { resolveProjectRoot } from '../../safety/paths.js';
import {
    ALL_MUTATING,
    NAMED_ONLY_TOOLS,
    PREAPPROVABLE_TOOLS,
    ignoredProjectApprovalWarning,
    readApprovalState,
    savePreapproval,
    saveUnmarkedAllowance,
    validatePreapproval,
    validateUnmarkedAllowance,
    type ApprovalState,
} from '../../safety/preapproval.js';
import { dryRunPreview, mcpError, mcpText, resolveEnvironment } from './shared.js';

/** The production policy as shown to the agent: IDs, display names, tools and expiry. Never secrets. */
export function describeProductionPolicy(state: ApprovalState, orgId?: string) {
    const inOrg = <T extends { orgId: string }>(list: T[]) => (orgId ? list.filter((e) => e.orgId === orgId) : list);
    const warning = ignoredProjectApprovalWarning();
    return {
        source: state.source,
        productionPreapprovals: inOrg(state.productionPreapprovals),
        unmarkedArtifactAllowances: inOrg(state.unmarkedArtifactAllowances),
        ...(state.invalid.length ? { invalid: state.invalid } : {}),
        ...(warning ? { ignoredProjectApproval: warning } : {}),
    };
}

const scopeInputs = {
    environment: z.string().describe('Production environment name or ID; stored by its resolved ID'),
    expires: z.string().optional().describe('ISO 8601 date-time after which the entry is ignored'),
    thisProjectOnly: z
        .boolean()
        .optional()
        .describe('Apply only to tools run in the current project (its root path is stored)'),
    clear: z.boolean().optional().describe('Remove the entry for this organization, environment and project'),
    confirm: z.boolean().optional().describe('Write the change. Without it the tool returns a preview'),
};

export function registerProfileTools(server: McpServer, client?: AnypointClient) {
    server.registerTool(
        'get_project_profile',
        {
            title: 'Get Project Profile',
            description:
                'Returns the currently active Anypoint profile for this project, how it was resolved (flag, env, project-file, or default), lists all available profiles, and shows the user-level production policy: production pre-approvals and unmarked-artifact allowances, each bound to an organization and environment ID. Use this to understand which Anypoint org/credentials are in use and which production writes skip confirmProduction.',
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
                productionPolicy: describeProductionPolicy(readApprovalState()),
            });
        },
    );

    server.registerTool(
        'set_project_profile',
        {
            title: 'Set Project Profile',
            description:
                'Binds the current project directory to a named Anypoint profile by writing .anypoint-connect.json (the nearest one, walking up, unless directory is given). Other fields of the file are kept. Production approvals are not stored here; see set_production_preapproval.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            inputSchema: {
                profile: z.string().describe('The profile name to bind to this project directory'),
                directory: z
                    .string()
                    .optional()
                    .describe(
                        'Directory to write .anypoint-connect.json in (default: the nearest existing one, else cwd)',
                    ),
            },
        },
        async ({ profile, directory }) => {
            try {
                const profiles = listProfiles();
                const filePath = writeProjectConfig(profile, directory);
                if (profiles.length > 0 && !profiles.includes(profile)) {
                    return mcpText(
                        `Warning: Profile "${profile}" does not exist yet. Available profiles: ${profiles.join(', ')}. The binding was written to ${filePath}, but you'll need to run "anc config init --profile ${profile}" to set up credentials.`,
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

    /** Resolve the scope of an entry: org and environment IDs, display name, optional project root. */
    async function resolveScope(environment: string, thisProjectOnly?: boolean) {
        if (!client) throw new Error('No Anypoint client');
        const { orgId, env } = await resolveEnvironment(client, environment);
        if (!isProductionEnv(env.name, env.isProduction)) {
            throw new Error(`${env.name} is not a production environment; production policy applies only there`);
        }
        return {
            env,
            scope: {
                orgId,
                environmentId: env.id,
                environmentName: env.name,
                ...(thisProjectOnly ? { projectPath: resolveProjectRoot() } : {}),
            },
        };
    }

    server.registerTool(
        'set_production_preapproval',
        {
            title: 'Set Production Pre-approval',
            description:
                'Pre-approves production writes for one organization and environment (stored by ID in the user-level ~/.anypoint-connect/production-approvals.json, never in the repository), so the named tools do not need confirmProduction (CLI: the typed phrase) until it expires. The entry is scoped to the organization ID and environment ID, not to a profile or credential: it applies to every profile on this machine that resolves to that organization and environment, survives profile switches within the organization, and never matches another organization. confirm: true, expectedSha256, expectedDeploymentId and every refusal still apply. ' +
                `tools is a list or "${ALL_MUTATING}" (all of ${PREAPPROVABLE_TOOLS.join(', ')} except ${NAMED_ONLY_TOOLS.join(', ')}, which must be named). Previews by default; pass confirm: true to write, clear: true to remove.`,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            inputSchema: {
                ...scopeInputs,
                tools: z
                    .union([z.literal(ALL_MUTATING), z.array(z.enum(PREAPPROVABLE_TOOLS)).min(1)])
                    .optional()
                    .describe(`Tool names, or "${ALL_MUTATING}". Required unless clear is true`),
            },
        },
        async ({ environment, tools, expires, thisProjectOnly, clear, confirm }) => {
            try {
                const { scope } = await resolveScope(environment, thisProjectOnly);
                if (!clear && !tools) throw new Error('Pass tools, or clear: true');
                const entry = clear ? null : validatePreapproval({ ...scope, tools, ...(expires ? { expires } : {}) });
                const preview = {
                    action: clear ? 'clear production pre-approval' : 'set production pre-approval',
                    scope,
                    ...(entry ? { entry } : {}),
                    current: readApprovalState().productionPreapprovals.filter((e) => e.orgId === scope.orgId),
                };
                if (!confirm) return dryRunPreview(preview);
                const file = savePreapproval(scope, entry);
                return mcpText({
                    message: clear ? 'Production pre-approval cleared.' : 'Production pre-approval set.',
                    file,
                    productionPolicy: describeProductionPolicy(readApprovalState(), scope.orgId),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'set_unmarked_artifact_allowance',
        {
            title: 'Allow Unmarked Artifacts in Production',
            description:
                'Allows jars without a mule-build build marker (built by another pipeline) to be deployed to one production organization and environment, stored by ID in the user-level ~/.anypoint-connect/production-approvals.json. Like a pre-approval it is scoped to the organization ID and environment ID, not to a profile or credential. Without it such jars are refused for production as "build provenance unknown". It never admits a jar whose marker says it is not production deployable, or an invalid marker. Previews by default; pass confirm: true to write, clear: true to remove.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            inputSchema: scopeInputs,
        },
        async ({ environment, expires, thisProjectOnly, clear, confirm }) => {
            try {
                const { scope } = await resolveScope(environment, thisProjectOnly);
                const entry = clear ? null : validateUnmarkedAllowance({ ...scope, ...(expires ? { expires } : {}) });
                const preview = {
                    action: clear ? 'clear unmarked-artifact allowance' : 'allow unmarked artifacts',
                    scope,
                    ...(entry ? { entry } : {}),
                    current: readApprovalState().unmarkedArtifactAllowances.filter((e) => e.orgId === scope.orgId),
                };
                if (!confirm) return dryRunPreview(preview);
                const file = saveUnmarkedAllowance(scope, entry);
                return mcpText({
                    message: clear ? 'Unmarked-artifact allowance cleared.' : 'Unmarked artifacts allowed.',
                    file,
                    productionPolicy: describeProductionPolicy(readApprovalState(), scope.orgId),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
