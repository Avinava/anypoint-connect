/**
 * Design Center CLI Commands
 * anc design-center (alias: dc) list | files | pull | push | publish
 */

import { Command } from 'commander';
import * as fs from 'fs';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printTable } from '../utils/formatter.js';
import { confirmAction, createClient } from './shared.js';
import type { AnypointClient } from '../client/AnypointClient.js';

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
    const dc = new Command('design-center').alias('dc').description('Manage API specs in Anypoint Design Center');

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
                log.error(`Failed: ${errorMessage(error)}`);
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
                log.error(`Failed: ${errorMessage(error)}`);
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
                log.error(`Download failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    // ── push ────────────────────────────────────────

    dc.command('push')
        .description('Preview, then sync a local file to Design Center (conflict-checked and verified)')
        .argument('<project>', 'Project name or ID')
        .argument('<localFile>', 'Local file to upload')
        .option('-p, --path <path>', 'Remote file path (overrides auto-detection)')
        .option('-b, --branch <branch>', 'Branch name', 'master')
        .option('-m, --message <msg>', 'Commit message')
        .option('-y, --yes', 'Apply without asking for confirmation', false)
        .action(async (project: string, localFile: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const proj = await resolveProject(client, orgId, project);

                if (!fs.existsSync(localFile)) {
                    throw new Error(`File not found: ${localFile}`);
                }
                const content = fs.readFileSync(localFile, 'utf-8');
                const remotePath =
                    opts.path ||
                    (await client.designCenter.resolveFilePath(
                        orgId,
                        proj.id,
                        localFile.split('/').pop() || localFile,
                        opts.branch,
                    ));

                const preview = await client.designCenterWorkflow.previewSync(
                    orgId,
                    proj.id,
                    [{ path: remotePath, content }],
                    opts.branch,
                    opts.message,
                );
                log.info(`${localFile} → ${preview.project}/${remotePath} [${preview.branch}]`);
                for (const entry of preview.entries) log.kv(entry.path, entry.action);

                if (preview.entries.every((entry) => entry.action === 'unchanged')) {
                    log.success('Design Center already matches the local file; nothing to push.');
                    return;
                }
                if (!opts.yes && !(await confirmAction('Push these changes to Design Center?'))) {
                    log.warn('Push cancelled');
                    return;
                }

                const result = await client.designCenterWorkflow.sync(preview.previewToken);
                log.success(`Pushed and verified ${result.changed} file(s) in ${result.project} [${result.branch}]`);
            } catch (error) {
                log.error(`Push failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    // ── publish ─────────────────────────────────────

    dc.command('publish')
        .description('Preview, then publish a Design Center project to Exchange (source-bound and verified)')
        .argument('<project>', 'Project name or ID')
        .requiredOption('--version <version>', 'Asset version (semver, e.g. 1.2.0)')
        .option('--api-version <v>', 'API version (e.g. v1)', 'v1')
        .option('--name <name>', 'Asset name in Exchange (defaults to project name)')
        .option('--asset-id <id>', 'Asset ID in Exchange (defaults to the project exchange.json, then the name)')
        .option('--classifier <c>', 'Classifier: raml, raml-fragment, oas, oas3', 'raml')
        .option('--main <file>', 'Main spec file name (defaults to the project exchange.json)')
        .option('-b, --branch <branch>', 'Branch name', 'master')
        .option('-y, --yes', 'Publish without asking for confirmation', false)
        .action(async (project: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const proj = await resolveProject(client, orgId, project);

                const preview = await client.designCenterWorkflow.previewPublication(
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
                log.info(`Publish ${preview.project} [${preview.branch}] to Exchange`);
                log.kv(
                    'Coordinates',
                    `${preview.coordinates.groupId}:${preview.coordinates.assetId}:${preview.coordinates.version}`,
                );
                log.kv('Main file', preview.mainFile);
                log.kv('Classifier', String(preview.classifier));
                log.kv('Source SHA-256', preview.sourceHash);

                if (!opts.yes && !(await confirmAction('Publish this asset version to Exchange?'))) {
                    log.warn('Publish cancelled');
                    return;
                }

                const result = await client.designCenterWorkflow.publish(preview.previewToken);
                log.success('Published to Exchange and verified the artifact');
                log.kv('Group ID', result.groupId);
                log.kv('Asset ID', result.assetId);
                log.kv('Version', result.version);
            } catch (error) {
                log.error(`Publish failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    return dc;
}
