/**
 * MCP Tool Registrar: deployed artifact tools
 * compare_deployed_artifact
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { DEFAULT_JAR_MAX_BYTES } from '../../api/ExchangeApi.js';
import { resolveProjectRoot, resolveReadablePath } from '../../safety/paths.js';
import { compareJarToGit, compareJarToJar, fetchDeployedJar } from '../../workflows/artifact-compare.js';
import { mcpError, mcpText, resolveEnvironment } from './shared.js';

/** Resolve a directory inside the project root, following symlinks. */
function resolveProjectDirectory(dir: string, root: string): string {
    const absolute = path.resolve(root, dir);
    if (!fs.existsSync(absolute)) throw new Error(`Directory not found: ${dir}`);
    const real = fs.realpathSync(absolute);
    const relative = path.relative(root, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Directory must be inside the project root (${root}): ${dir}`);
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`Not a directory: ${dir}`);
    return real;
}

const againstSchema = z.union([
    z.object({
        jarPath: z.string().describe('Path inside the project root to a built application jar'),
    }),
    z.object({
        repoPath: z.string().describe('Mule project directory inside the project root (a git checkout)'),
        gitRef: z.string().optional().describe('Commit, branch or tag to compare (default HEAD)'),
        includeWorkingTree: z
            .boolean()
            .optional()
            .describe('Include uncommitted and untracked changes (compares the working tree on top of HEAD)'),
    }),
]);

export function registerArtifactTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'compare_deployed_artifact',
        {
            title: 'Compare Deployed Artifact',
            description:
                'Answers "does this repo (or jar) match what is deployed?". Downloads the jar the application currently runs from Exchange and compares it with a local jar (SHA-256, then entry by entry) or with a git checkout (git blob IDs of src/main/mule, src/main/resources and pom.xml at a ref, optionally plus the working tree). Returns a verdict of identical or differs, the pom version on each side, changed / missingInRepo / extraInRepo paths with sizes, and dependency differences as group:artifact:version. With a jar, \'repo\' means the local jar. Only names, sizes and hashes are returned, never file contents.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                against: againstSchema.describe('{jarPath} or {repoPath, gitRef?, includeWorkingTree?}'),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ appName, environment, against }) => {
            try {
                const root = resolveProjectRoot();
                // Validate local inputs before downloading anything.
                const local =
                    'jarPath' in against
                        ? resolveReadablePath(against.jarPath, { projectRoot: root, maxBytes: DEFAULT_JAR_MAX_BYTES })
                        : undefined;
                const repoPath = 'repoPath' in against ? resolveProjectDirectory(against.repoPath, root) : undefined;

                const { orgId, env } = await resolveEnvironment(client, environment);
                const deployed = await fetchDeployedJar(client, orgId, env, appName, {
                    maxBytes: DEFAULT_JAR_MAX_BYTES,
                });

                const comparison = local
                    ? compareJarToJar(deployed.buffer, fs.readFileSync(local.path), path.relative(root, local.path))
                    : await compareJarToGit(deployed.buffer, {
                          repoPath: repoPath!,
                          gitRef: 'repoPath' in against ? against.gitRef : undefined,
                          includeWorkingTree: 'repoPath' in against ? against.includeWorkingTree : undefined,
                      });

                return mcpText({
                    appName,
                    environment: env.name,
                    deployed: { ...deployed.ref, sha256: deployed.sha256, size: deployed.buffer.length },
                    ...(deployed.md5Matches ? {} : { warning: 'Downloaded jar does not match the Exchange MD5' }),
                    ...comparison,
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
