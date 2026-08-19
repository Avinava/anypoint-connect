/**
 * MCP Tool Registrar — Design Center tools
 * list_design_center_projects, get_design_center_files,
 * read_design_center_file, update_design_center_file, publish_to_exchange
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError } from './shared.js';

export function registerDesignCenterTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'list_design_center_projects',
        {
            title: 'List Design Center Projects',
            description:
                "Lists all API specification projects in Anypoint Design Center. Returns each project's name, ID, type (raml, oas, raml-fragment), and creation date. Use this to discover available API specs before reading or editing them.",
            annotations: { readOnlyHint: true },
        },
        async () => {
            try {
                const orgId = await client.getDefaultOrgId();
                const projects = await client.designCenter.getProjects(orgId);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                projects.map((p) => ({
                                    name: p.name,
                                    id: p.id,
                                    type: p.type,
                                    createdDate: p.createdDate,
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

    server.registerTool(
        'get_design_center_files',
        {
            title: 'List Files in Design Center Project',
            description:
                'Lists all files and folders in a Design Center project branch. Returns file paths and types. Use this to discover the project structure before reading specific files like the main RAML or OAS spec.',
            inputSchema: {
                project: z.string().describe('Exact project name or project ID'),
                branch: z.string().optional().describe('Branch name (default: "master")'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ project, branch }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const proj = await client.designCenter.findByNameOrThrow(orgId, project);

                const files = await client.designCenter.getFiles(orgId, proj.id, branch || 'master');

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ project: proj.name, branch: branch || 'master', files }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'read_design_center_file',
        {
            title: 'Read Design Center File',
            description:
                'Reads the content of a specific file from a Design Center project. Returns the raw RAML, OAS, JSON, or other file content as text. Use this to inspect API specifications, data types, examples, or configuration files.',
            inputSchema: {
                project: z.string().describe('Exact project name or project ID'),
                filePath: z
                    .string()
                    .describe('File path within the project (e.g. "api.raml", "examples/response.json")'),
                branch: z.string().optional().describe('Branch name (default: "master")'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ project, filePath, branch }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const proj = await client.designCenter.findByNameOrThrow(orgId, project);

                // Resolve path so partial/basename inputs work
                const resolvedPath = await client.designCenter.resolveFilePath(
                    orgId,
                    proj.id,
                    filePath,
                    branch || 'master',
                );

                const content = await client.designCenter.getFileContent(
                    orgId,
                    proj.id,
                    resolvedPath,
                    branch || 'master',
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `File: ${resolvedPath}\nProject: ${proj.name}\nBranch: ${branch || 'master'}\n\n${content}`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'update_design_center_file',
        {
            title: 'Update Design Center File',
            description:
                'Updates a file in a Design Center project by atomically acquiring a lock, saving the new content, and releasing the lock. Use this after reading a RAML/OAS file, making changes, and wanting to push the updated spec back to Design Center. The lock ensures no concurrent edits are lost.',
            inputSchema: {
                project: z.string().describe('Exact project name or project ID'),
                filePath: z.string().describe('File path within the project (e.g. "api.raml")'),
                content: z.string().describe('The full updated file content to save'),
                branch: z.string().optional().describe('Branch name (default: "master")'),
                commitMessage: z.string().optional().describe('Commit message describing the change'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ project, filePath, content, branch, commitMessage }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const proj = await client.designCenter.findByNameOrThrow(orgId, project);

                // Verify the file path exists in the project (with suggestions on mismatch)
                const resolvedPath = await client.designCenter.resolveFilePath(
                    orgId,
                    proj.id,
                    filePath,
                    branch || 'master',
                );

                await client.designCenter.updateFile(
                    orgId,
                    proj.id,
                    resolvedPath,
                    content,
                    branch || 'master',
                    commitMessage,
                );

                const lines = content.split('\n').length;
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Updated "${resolvedPath}" in ${proj.name} [${branch || 'master'}] (${lines} lines, ${content.length} bytes).`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'publish_to_exchange',
        {
            title: 'Publish Design Center Project to Exchange (Legacy)',
            description:
                'Legacy direct publication retained for compatibility. Prefer preview_exchange_publication followed by publish_previewed_exchange_asset so exact coordinates and source content are approval-bound.',
            inputSchema: {
                project: z.string().describe('Exact project name or project ID'),
                version: z.string().describe('Asset version in semver format (e.g. "1.2.0")'),
                apiVersion: z.string().optional().describe('API version label (default: "v1")'),
                classifier: z
                    .string()
                    .optional()
                    .describe('Spec type: "raml", "raml-fragment", "oas", "oas3" (default: "raml")'),
                name: z.string().optional().describe('Asset name in Exchange (defaults to project name)'),
                branch: z.string().optional().describe('Branch to publish from (default: "master")'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async ({ project, version, apiVersion, classifier, name, branch }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const proj = await client.designCenter.findByNameOrThrow(orgId, project);

                const result = await client.designCenter.publishToExchange(
                    orgId,
                    proj.id,
                    {
                        name: name || proj.name,
                        apiVersion: apiVersion || 'v1',
                        version,
                        classifier: classifier || 'raml',
                    },
                    branch || 'master',
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Published "${proj.name}" to Exchange!\nGroup ID: ${result.groupId}\nAsset ID: ${result.assetId}\nVersion: ${result.version}`,
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'list_design_center_branches',
        {
            title: 'List Design Center Branches',
            description: 'Lists branches for one exactly identified Design Center project.',
            inputSchema: { project: z.string().describe('Exact project name or project ID') },
            annotations: { readOnlyHint: true },
        },
        async ({ project }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const resolved = await client.designCenter.findByNameOrThrow(orgId, project);
                const branches = await client.designCenter.getBranches(orgId, resolved.id);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ project: resolved.name, branches }, null, 2) }],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'preview_design_center_project_create',
        {
            title: 'Preview Design Center Project Creation',
            description:
                'Checks exact-name collisions and returns a single-use 10-minute token. This tool does not create anything.',
            inputSchema: {
                name: z.string().min(1).describe('Neutral project name'),
                classifier: z.enum(['raml', 'oas']).describe('Contract classifier'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ name, classifier }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const preview = await client.designCenterWorkflow.previewProjectCreate(orgId, name, classifier);
                return { content: [{ type: 'text', text: JSON.stringify(preview, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'create_design_center_project',
        {
            title: 'Create Previewed Design Center Project',
            description:
                'Consumes a single-use creation preview token and rechecks exact-name collision before creating the project.',
            inputSchema: {
                previewToken: z.string().describe('Token returned by preview_design_center_project_create'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async ({ previewToken }) => {
            try {
                const project = await client.designCenterWorkflow.createProject(previewToken);
                return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    const syncFilesSchema = z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1);

    server.registerTool(
        'preview_design_center_sync',
        {
            title: 'Preview Design Center File Sync',
            description:
                'Computes create, update, and unchanged actions with content hashes. It never deletes, moves, renames, or writes files.',
            inputSchema: {
                project: z.string().describe('Exact project name or project ID'),
                files: syncFilesSchema,
                branch: z.string().optional().describe('Branch name (default: master)'),
                commitMessage: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ project, files, branch, commitMessage }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const preview = await client.designCenterWorkflow.previewSync(
                    orgId,
                    project,
                    files,
                    branch || 'master',
                    commitMessage,
                );
                return { content: [{ type: 'text', text: JSON.stringify(preview, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'sync_design_center_files',
        {
            title: 'Apply Previewed Design Center Sync',
            description:
                'Consumes a single-use preview, locks once, aborts atomically on hash conflicts, batch-saves, and verifies every changed file.',
            inputSchema: { previewToken: z.string().describe('Token returned by preview_design_center_sync') },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({ previewToken }) => {
            try {
                const result = await client.designCenterWorkflow.sync(previewToken);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'preview_exchange_publication',
        {
            title: 'Preview Exchange Publication',
            description:
                'Binds exact project, branch, coordinates, classifier, main file, API version, and source hash to a single-use token. It does not publish.',
            inputSchema: {
                project: z.string().describe('Exact project name or project ID'),
                name: z.string().min(1),
                apiVersion: z.string().min(1),
                version: z.string().min(1),
                classifier: z.enum(['raml', 'raml-fragment', 'oas', 'oas3']),
                main: z.string().min(1),
                groupId: z.string().min(1),
                assetId: z.string().min(1),
                branch: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ project, branch, ...options }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const preview = await client.designCenterWorkflow.previewPublication(
                    orgId,
                    project,
                    options,
                    branch || 'master',
                );
                return { content: [{ type: 'text', text: JSON.stringify(preview, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'publish_previewed_exchange_asset',
        {
            title: 'Publish Previewed Exchange Asset',
            description:
                'Consumes the publication token, rejects source drift, publishes once, then verifies the downloaded Exchange artifact hash.',
            inputSchema: { previewToken: z.string().describe('Token returned by preview_exchange_publication') },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async ({ previewToken }) => {
            try {
                const result = await client.designCenterWorkflow.publish(previewToken);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'explain_api_governance_plan',
        {
            title: 'Explain API Governance Plan',
            description:
                'Reads the centralized governance rulesets that would apply to planned or published API coordinates.',
            inputSchema: {
                groupId: z.string(),
                assetId: z.string(),
                version: z.string().optional(),
                filter: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ groupId, assetId, version, filter }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const ownerId = await client.designCenter.getOwnerId();
                const result = version
                    ? await client.governance.explainPublished(orgId, ownerId, { groupId, assetId, version })
                    : await client.governance.explainPlanned(orgId, ownerId, { groupId, assetId, filter });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_api_governance_conformance',
        {
            title: 'Get API Governance Conformance',
            description:
                'Reads centralized governance conformance for exact API asset versions, filtered by the caller permissions.',
            inputSchema: {
                groupId: z.string(),
                assetId: z.string(),
                minorVersion: z.string(),
                versions: z.array(z.string()).min(1),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ groupId, assetId, minorVersion, versions }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const ownerId = await client.designCenter.getOwnerId();
                const result = await client.governance.conformanceStatus(orgId, ownerId, {
                    orgId,
                    groupId,
                    assetId,
                    minorVersion,
                    versions,
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
