/**
 * Exchange CLI Commands
 * anc exchange search | info | download-spec
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

export function createExchangeCommand(): Command {
    const exchange = new Command('exchange').description('Search and download assets from Anypoint Exchange');

    exchange
        .command('search')
        .description('Search for assets in Exchange')
        .argument('[query]', 'Search query')
        .option('-t, --type <type>', 'Asset type (rest-api, app, connector, template, example, policy)')
        .option('-l, --limit <n>', 'Max results', '20')
        .action(async (query: string | undefined, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();

                const assets = await client.exchange.searchAssets(orgId, {
                    search: query,
                    type: opts.type,
                    limit: parseInt(opts.limit),
                });

                if (assets.length === 0) {
                    log.info('No assets found');
                    return;
                }

                log.header(`Exchange Assets (${assets.length})`);
                printTable(
                    ['Name', 'Type', 'Version', 'Asset ID'],
                    assets.map((a) => [
                        a.name || a.assetId,
                        a.type || '-',
                        a.version || '-',
                        `${a.groupId}/${a.assetId}`,
                    ])
                );
            } catch (error) {
                log.error(`Search failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    exchange
        .command('info')
        .description('Get detailed asset information')
        .argument('<assetPath>', 'Asset path: groupId/assetId or just assetId')
        .option('-v, --version <v>', 'Specific version')
        .action(async (assetPath: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();

                let groupId: string, assetId: string;
                if (assetPath.includes('/')) {
                    [groupId, assetId] = assetPath.split('/');
                } else {
                    groupId = orgId;
                    assetId = assetPath;
                }

                const detail = await client.exchange.getAsset(groupId, assetId, opts.version);

                log.header(detail.name || detail.assetId);
                log.kv('Group ID', detail.groupId);
                log.kv('Asset ID', detail.assetId);
                log.kv('Version', detail.version);
                log.kv('Type', detail.type);
                log.kv('Status', detail.status || '-');
                if (detail.description) log.kv('Description', detail.description);

                if (detail.files && detail.files.length > 0) {
                    console.log();
                    log.bold('  Files:');
                    for (const f of detail.files) {
                        log.kv(`    ${f.classifier}`, f.packaging || '-');
                    }
                }

                if (detail.versions && detail.versions.length > 0) {
                    console.log();
                    log.bold('  Versions:');
                    for (const v of detail.versions.slice(0, 10)) {
                        log.kv(`    ${v.version}`, v.status);
                    }
                    if (detail.versions.length > 10) {
                        log.dim(`    ... and ${detail.versions.length - 10} more`);
                    }
                }
            } catch (error) {
                log.error(`Failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    exchange
        .command('download-spec')
        .description('Download API specification (RAML/OAS)')
        .argument('<assetPath>', 'Asset path: groupId/assetId or just assetId')
        .option('-v, --version <v>', 'Specific version')
        .option('-o, --output <file>', 'Output file path')
        .action(async (assetPath: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();

                let groupId: string, assetId: string;
                if (assetPath.includes('/')) {
                    [groupId, assetId] = assetPath.split('/');
                } else {
                    groupId = orgId;
                    assetId = assetPath;
                }

                log.info(`Downloading spec for ${groupId}/${assetId}...`);

                const spec = await client.exchange.downloadSpec(groupId, assetId, opts.version);
                const outputPath = opts.output || spec.fileName;

                fs.writeFileSync(outputPath, spec.content);
                log.success(`Downloaded ${spec.classifier} spec → ${outputPath}`);
            } catch (error) {
                log.error(`Download failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    return exchange;
}
