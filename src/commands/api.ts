/**
 * API Manager CLI Commands
 * anc api list | policies | sla-tiers | alerts
 */

import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printTable } from '../utils/formatter.js';
import { createClient } from './shared.js';

export function createApiCommand(): Command {
    const api = new Command('api').description('Manage API instances, policies, and SLA tiers');

    api.command('list')
        .description('List API instances in an environment')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const assets = await client.apiManager.getApis(orgId, env.id);

                if (assets.length === 0) {
                    log.info(`No API instances in ${env.name}`);
                    return;
                }

                log.header(`API Instances in ${env.name}`);

                const rows: string[][] = [];
                for (const asset of assets) {
                    for (const instance of asset.apis) {
                        rows.push([
                            asset.exchangeAssetName,
                            String(instance.id),
                            instance.status,
                            instance.assetVersion || '-',
                            instance.technology || '-',
                            instance.endpointUri || '-',
                        ]);
                    }
                }

                printTable(['API Name', 'ID', 'Status', 'Version', 'Technology', 'Endpoint'], rows);
            } catch (error) {
                log.error(`Failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    api.command('policies')
        .description('List policies applied to an API')
        .argument('<apiName>', 'API name or ID')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (apiName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                // Try as numeric ID first, then search by name
                let apiId: number;
                const numId = parseInt(apiName);
                if (!isNaN(numId)) {
                    apiId = numId;
                } else {
                    const found = await client.apiManager.findByName(orgId, env.id, apiName);
                    if (!found) {
                        log.error(`API "${apiName}" not found in ${env.name}`);
                        process.exit(1);
                    }
                    apiId = found.instance.id;
                    log.dim(`  Resolved: ${found.asset.exchangeAssetName} (ID: ${apiId})`);
                }

                const policies = await client.apiManager.getPolicies(orgId, env.id, apiId);

                if (policies.length === 0) {
                    log.info('No policies applied');
                    return;
                }

                log.header(`Policies (${policies.length})`);
                for (const p of policies) {
                    log.kv(
                        'Policy',
                        `${p.template?.assetId || p.policyTemplateId || 'unknown'} v${p.template?.assetVersion || '?'}`,
                    );
                    log.kv('  Order', String(p.order ?? '-'));
                    log.kv('  Disabled', String(p.disabled ?? false));
                    if (p.configurationData) {
                        log.kv('  Config', JSON.stringify(p.configurationData));
                    }
                    console.log();
                }
            } catch (error) {
                log.error(`Failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    api.command('sla-tiers')
        .description('List SLA tiers for an API')
        .argument('<apiName>', 'API name or ID')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (apiName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                let apiId: number;
                const numId = parseInt(apiName);
                if (!isNaN(numId)) {
                    apiId = numId;
                } else {
                    const found = await client.apiManager.findByName(orgId, env.id, apiName);
                    if (!found) {
                        log.error(`API "${apiName}" not found in ${env.name}`);
                        process.exit(1);
                    }
                    apiId = found.instance.id;
                }

                const tiers = await client.apiManager.getSlaTiers(orgId, env.id, apiId);

                if (tiers.length === 0) {
                    log.info('No SLA tiers configured');
                    return;
                }

                printTable(
                    ['Name', 'Status', 'Auto-Approve', 'Limits', 'Apps'],
                    tiers.map((t) => [
                        t.name,
                        t.status,
                        t.autoApprove ? 'Yes' : 'No',
                        t.limits
                            .map((l) => `${l.maximumRequests} req/${l.timePeriodInMilliseconds / 1000}s`)
                            .join(', '),
                        String(t.applicationCount),
                    ]),
                );
            } catch (error) {
                log.error(`Failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    return api;
}
