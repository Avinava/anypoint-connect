/**
 * Design Center CLI Commands
 * anc dc list | files | pull | push | publish
 */

import { Command } from 'commander';
import * as fs from 'fs';
import { getConfig } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { printTable } from '../utils/formatter.js';
import { AnypointClient } from '../client/AnypointClient.js';

function createClient(): AnypointClient {
    const config = getConfig();
    return new AnypointClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.callbackUrl,
        baseUrl: config.baseUrl,
    });
}

async function resolveProject(client: AnypointClient, orgId: string, nameOrId: string) {
    const project = await client.designCenter.findByName(orgId, nameOrId);
    if (!project) {
        // Try by ID
        try {
            return await client.designCenter.getProject(orgId, nameOrId);
        } catch {
            throw new Error(`Project "${nameOrId}" not found. Use "anc dc list" to see available projects.`);
        }
    }
    return project;
}

export function createDesignCenterCommand(): Command {
    const dc = new Command('dc').description('Manage API specs in Anypoint Design Center');

    // ── list ────────────────────────────────────────

    dc.command('list')
        .description('List all Design Center projects')
        .action(async () => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const projects = await client.designCenter.getProjects(orgId);

                if (projects.length === 0) {
                    log.info('No Design Center projects found');
                    return;
                }

                log.header(`Design Center Projects (${projects.length})`);
                printTable(
                    ['Name', 'Type', 'ID'],
                    projects.map((p) => [p.name, p.type || '-', p.id]),
                );
            } catch (error) {
                log.error(`Failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    // ── files ───────────────────────────────────────

    dc.command('files')
        .description('List files in a Design Center project')
        .argument('<project>', 'Project name or ID')
        .option('-b, --branch <branch>', 'Branch name', 'master')
        .action(async (project: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const proj = await resolveProject(client, orgId, project);

                log.info(`  Resolved: ${proj.name} (ID: ${proj.id})`);

                const files = await client.designCenter.getFiles(orgId, proj.id, opts.branch);

                log.header(`Files in ${proj.name} [${opts.branch}]`);
                printTable(
                    ['Path', 'Type'],
                    files.map((f) => [f.path, f.type]),
                );
            } catch (error) {
                log.error(`Failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    // ── pull ────────────────────────────────────────

    dc.command('pull')
        .description('Download a file from Design Center to local disk')
        .argument('<project>', 'Project name or ID')
        .argument('[filePath]', 'File path within the project (omit to list files)')
        .option('-b, --branch <branch>', 'Branch name', 'master')
        .option('-o, --output <file>', 'Output file path (defaults to file name)')
        .action(async (project: string, filePath: string | undefined, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const proj = await resolveProject(client, orgId, project);

                if (!filePath) {
                    // List files instead
                    const files = await client.designCenter.getFiles(orgId, proj.id, opts.branch);
                    log.header(`Files in ${proj.name} — specify one to pull:`);
                    for (const f of files.filter((f) => f.type.toLowerCase() === 'file')) {
                        console.log(`  ${f.path}`);
                    }
                    return;
                }

                log.info(`Downloading ${filePath} from ${proj.name}...`);
                const content = await client.designCenter.getFileContent(orgId, proj.id, filePath, opts.branch);

                const outputPath = opts.output || filePath.split('/').pop() || filePath;
                fs.writeFileSync(outputPath, content);
                log.success(`Downloaded → ${outputPath} (${content.length} bytes)`);
            } catch (error) {
                log.error(`Download failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    // ── push ────────────────────────────────────────

    dc.command('push')
        .description('Push a local file to Design Center (lock → save → unlock)')
        .argument('<project>', 'Project name or ID')
        .argument('<localFile>', 'Local file to upload')
        .option('-p, --path <path>', 'Remote file path (overrides auto-detection)')
        .option('-b, --branch <branch>', 'Branch name', 'master')
        .option('-m, --message <msg>', 'Commit message')
        .action(async (project: string, localFile: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const proj = await resolveProject(client, orgId, project);

                if (!fs.existsSync(localFile)) {
                    log.error(`File not found: ${localFile}`);
                    process.exit(1);
                }

                const content = fs.readFileSync(localFile, 'utf-8');

                // Smart path resolution: verify the file exists in the project
                let remotePath: string;
                if (opts.path) {
                    remotePath = opts.path;
                } else {
                    const basename = localFile.split('/').pop() || localFile;
                    remotePath = await client.designCenter.resolveFilePath(orgId, proj.id, basename, opts.branch);
                }

                const lines = content.split('\n').length;
                log.info(`Pushing ${localFile} → ${proj.name}/${remotePath} [${opts.branch}]`);
                log.dim(`  ${lines} lines, ${content.length} bytes`);
                log.dim('  Acquiring lock...');

                await client.designCenter.updateFile(orgId, proj.id, remotePath, content, opts.branch, opts.message);

                log.success(`Pushed to Design Center: ${remotePath}`);
            } catch (error) {
                log.error(`Push failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    // ── publish ─────────────────────────────────────

    dc.command('publish')
        .description('Publish a Design Center project to Exchange')
        .argument('<project>', 'Project name or ID')
        .requiredOption('--version <version>', 'Asset version (semver, e.g. 1.2.0)')
        .option('--api-version <v>', 'API version (e.g. v1)', 'v1')
        .option('--name <name>', 'Asset name in Exchange (defaults to project name)')
        .option('--asset-id <id>', 'Asset ID in Exchange (defaults to project name)')
        .option('--classifier <c>', 'Classifier: raml, raml-fragment, oas, oas3', 'raml')
        .option('--main <file>', 'Main spec file name')
        .option('-b, --branch <branch>', 'Branch name', 'master')
        .action(async (project: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const proj = await resolveProject(client, orgId, project);

                log.info(`Publishing ${proj.name} to Exchange as v${opts.version}...`);

                const result = await client.designCenter.publishToExchange(
                    orgId,
                    proj.id,
                    {
                        name: opts.name || proj.name,
                        apiVersion: opts.apiVersion,
                        version: opts.version,
                        classifier: opts.classifier,
                        assetId: opts.assetId,
                        main: opts.main,
                    },
                    opts.branch,
                );

                log.success(`Published to Exchange!`);
                log.kv('Group ID', result.groupId);
                log.kv('Asset ID', result.assetId);
                log.kv('Version', result.version);
            } catch (error) {
                log.error(`Publish failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    return dc;
}
