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
                project: z.string().describe('Project name (partial match) or project ID'),
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
                project: z.string().describe('Project name (partial match) or project ID'),
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
                project: z.string().describe('Project name (partial match) or project ID'),
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
            title: 'Publish Design Center Project to Exchange',
            description:
                'Publishes an API specification from Design Center to Anypoint Exchange, making it discoverable and reusable across the organization. Specify the asset version (semver), API version, and classifier. This creates a new version of the asset in Exchange that can be used in API Manager, Studio, or other integrations.',
            inputSchema: {
                project: z.string().describe('Project name (partial match) or project ID'),
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
}
