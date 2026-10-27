/**
 * API Manager CLI Commands
 * anc api list | policies | sla-tiers | alerts | contracts | client-app | smoke
 */

import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printTable } from '../utils/formatter.js';
import { confirmAction, createClient } from './shared.js';
import type { AnypointClient } from '../client/AnypointClient.js';
import type { Environment } from '../api/AccessManagementApi.js';
import { isProductionEnv } from '../safety/guards.js';
import { checkPreapproval } from '../safety/preapproval.js';
import { redactText } from '../safety/secrets.js';
import {
    SAFE_METHODS,
    credentialVariants,
    describeClientApplication,
    executeSmokeTest,
    planSmokeTest,
    writeCredentialsFile,
} from '../client/smoke-test.js';

/** Accept a numeric API instance ID or an Exchange asset name. */
async function resolveApiId(client: AnypointClient, orgId: string, env: Environment, apiName: string): Promise<number> {
    const resolved = await client.apiManager.resolveApiInstance(orgId, env, apiName);
    if (resolved.asset && !/^\d+$/.test(apiName.trim())) {
        log.dim(`  Resolved: ${resolved.asset.exchangeAssetName} (ID: ${resolved.apiId})`);
    }
    return resolved.apiId;
}

function parseHeader(value: string, previous: Record<string, string> = {}): Record<string, string> {
    const index = value.indexOf(':');
    if (index <= 0) throw new Error(`Header must look like "Name: value": ${value}`);
    return { ...previous, [value.slice(0, index).trim()]: value.slice(index + 1).trim() };
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

    api.command('contracts')
        .description('List client application contracts on an API')
        .argument('<api>', 'API name or ID')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (apiName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const apiId = await resolveApiId(client, orgId, env, apiName);

                const contracts = await client.apiManager.getContracts(orgId, env.id, apiId);
                if (contracts.length === 0) {
                    log.info('No contracts');
                    return;
                }
                printTable(
                    ['Contract ID', 'Client App', 'App ID', 'Tier', 'Status'],
                    contracts.map((c) => [
                        String(c.id),
                        c.application?.name ?? '-',
                        String(c.application?.id ?? c.applicationId ?? '-'),
                        c.tier?.name ?? '-',
                        c.status,
                    ]),
                );
            } catch (error) {
                log.error(`Failed to list contracts: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    api.command('client-app')
        .description('Show a client application with its secret masked')
        .argument('<id>', 'Client application ID')
        .option('--write-credentials <file>', 'Write CLIENT_ID/CLIENT_SECRET in .env format (mode 0600)')
        .option('--overwrite', 'Replace the credentials file when it exists', false)
        .action(async (id: string, opts) => {
            let secrets: string[] = [];
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const app = await client.apiManager.getClientApplication(orgId, id);
                secrets = credentialVariants(undefined, app.clientSecret);

                const view = describeClientApplication(app);
                log.header(`Client application ${view.name}`);
                log.kv('ID', String(view.id));
                log.kv('Client ID', view.clientId);
                log.kv('Client secret', view.clientSecret);
                if (view.description) log.kv('Description', view.description);
                if (view.url) log.kv('URL', view.url);

                if (opts.writeCredentials) {
                    const written = writeCredentialsFile(opts.writeCredentials, app, { overwrite: opts.overwrite });
                    log.success(`Credentials written to ${written} (mode 0600)`);
                }
            } catch (error) {
                log.error(redactText(`Failed to get client application: ${errorMessage(error)}`, secrets));
                process.exitCode = 1;
            }
        });

    api.command('smoke')
        .description('Send one request to an API with its client credentials and report the result')
        .argument('<api>', 'API name or ID')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('--path <path>', 'Path appended to the API endpoint URI')
        .option('--url <url>', 'Absolute URL to call instead of the endpoint URI')
        .option('-X, --method <method>', 'HTTP method', 'GET')
        .option('--client-app <id>', 'Client application whose credentials to send')
        .option('-H, --header <header>', 'Extra request header "Name: value" (repeatable)', parseHeader)
        .option('-d, --data <body>', 'Request body')
        .option('--expect <status>', 'Expected status code', (v) => parseInt(v, 10))
        .option('--timeout <ms>', 'Request timeout in milliseconds', (v) => parseInt(v, 10))
        .option('-y, --yes', 'Send a non-GET request without asking for confirmation', false)
        .option('--allow-production', 'Allow a non-GET request in a production environment', false)
        .action(async (apiName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const plan = await planSmokeTest(client, orgId, env, {
                    api: apiName,
                    path: opts.path,
                    url: opts.url,
                    method: opts.method,
                    clientAppId: opts.clientApp,
                });

                if (!SAFE_METHODS.has(plan.method)) {
                    if (isProductionEnv(env.name, env.isProduction) && !opts.allowProduction) {
                        const decision = checkPreapproval({ orgId, env }, 'smoke_test_api');
                        if (!decision.productionPreapproved) {
                            log.error(`${plan.method} refused: ${env.name} is production; pass --allow-production.`);
                            process.exitCode = 1;
                            return;
                        }
                        log.warn(`Production ${plan.method} pre-approved (${decision.preapprovalSource})`);
                    }
                    if (!opts.yes && !(await confirmAction(`Send ${plan.method} ${plan.url}?`))) {
                        log.info('Cancelled');
                        return;
                    }
                }

                const result = await executeSmokeTest(client, orgId, plan, {
                    headers: opts.header,
                    body: opts.data,
                    expectStatus: opts.expect,
                    timeoutMs: opts.timeout,
                });

                log.header(`${result.request.method} ${result.request.url}`);
                log.kv('Status', `${result.status} ${result.statusText}`);
                log.kv('Latency', `${result.latencyMs} ms`);
                log.kv('Credentials', result.request.credentials);
                if (result.request.clientApp) {
                    log.kv('Client app', `${result.request.clientApp.name ?? ''} (${result.request.clientApp.id})`);
                }
                for (const [name, value] of Object.entries(result.headers)) log.kv(`  ${name}`, value);
                if (result.body.excerpt) {
                    console.log();
                    console.log(result.body.excerpt);
                    if (result.body.truncated) log.dim('  (body truncated)');
                }
                if (result.passed) log.success('Passed');
                else {
                    log.error(
                        result.expectStatus !== undefined
                            ? `Expected ${result.expectStatus}, got ${result.status}`
                            : `Failed with ${result.status}`,
                    );
                    process.exitCode = 1;
                }
            } catch (error) {
                log.error(errorMessage(error));
                process.exitCode = 1;
            }
        });

    return api;
}
