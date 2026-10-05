/**
 * API Manager CLI Commands
 * anc api list | policies | sla-tiers | alerts
 */

import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printTable } from '../utils/formatter.js';
import { createClient } from './shared.js';
import type { AnypointClient } from '../client/AnypointClient.js';
import type { Environment } from '../api/AccessManagementApi.js';

/** Accept a numeric API instance ID or an Exchange asset name. */
async function resolveApiId(client: AnypointClient, orgId: string, env: Environment, apiName: string): Promise<number> {
    const numId = Number(apiName);
    if (Number.isInteger(numId)) return numId;
    const found = await client.apiManager.findByName(orgId, env.id, apiName);
    if (!found) throw new Error(`API "${apiName}" not found in ${env.name}`);
    log.dim(`  Resolved: ${found.asset.exchangeAssetName} (ID: ${found.instance.id})`);
    return found.instance.id;
}

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

                const apiId = await resolveApiId(client, orgId, env, apiName);

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

                const apiId = await resolveApiId(client, orgId, env, apiName);

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

    api.command('alerts')
        .description('List alerts configured for an API')
        .argument('<apiName>', 'API name or ID')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (apiName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const apiId = await resolveApiId(client, orgId, env, apiName);

                const alerts = await client.apiManager.getAlerts(orgId, env.id, apiId);
                if (alerts.length === 0) {
                    log.info('No alerts configured');
                    return;
                }
                log.header(`Alerts (${alerts.length})`);
                console.log(JSON.stringify(alerts, null, 2));
            } catch (error) {
                log.error(`Failed to list alerts: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    return api;
}
