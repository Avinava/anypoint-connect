/**
 * MCP Tool Registrar — Design Center tools (preview-bound writes)
 * list_design_center_projects, list_design_center_branches, list_design_center_files, read_design_center_file, preview_create_design_center_project, create_design_center_project, preview_sync_design_center_files, sync_design_center_files, preview_publish_exchange_asset, publish_exchange_asset
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError, mcpText } from './shared.js';

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

                return mcpText(
                    projects.map((p) => ({
                        name: p.name,
                        id: p.id,
                        type: p.type,
                        createdDate: p.createdDate,
                    })),
                );
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
                return mcpText({ project: resolved.name, branches });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'list_design_center_files',
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

                return mcpText({ project: proj.name, branch: branch || 'master', files });
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

                return mcpText(
                    `File: ${resolvedPath}\nProject: ${proj.name}\nBranch: ${branch || 'master'}\n\n${content}`,
                );
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'preview_create_design_center_project',
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
                return mcpText(preview);
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
                previewToken: z.string().describe('Token returned by preview_create_design_center_project'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async ({ previewToken }) => {
            try {
                const project = await client.designCenterWorkflow.createProject(previewToken);
                return mcpText(project);
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    const syncFilesSchema = z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1);

    server.registerTool(
        'preview_sync_design_center_files',
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
                return mcpText(preview);
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
            inputSchema: { previewToken: z.string().describe('Token returned by preview_sync_design_center_files') },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
        async ({ previewToken }) => {
            try {
                const result = await client.designCenterWorkflow.sync(previewToken);
                return mcpText(result);
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'preview_publish_exchange_asset',
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
                return mcpText(preview);
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'publish_exchange_asset',
        {
            title: 'Publish Previewed Exchange Asset',
            description:
                'Consumes the publication token, rejects source drift, publishes once, then verifies the downloaded Exchange artifact hash.',
            inputSchema: { previewToken: z.string().describe('Token returned by preview_publish_exchange_asset') },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async ({ previewToken }) => {
            try {
                const result = await client.designCenterWorkflow.publish(previewToken);
                return mcpText(result);
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
