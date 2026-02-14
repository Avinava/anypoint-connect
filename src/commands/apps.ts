/**
 * Apps CLI Commands
 * anc apps list | status
 */

import { Command } from 'commander';
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

export function createAppsCommand(): Command {
    const apps = new Command('apps').description('Manage deployed applications');

    apps
        .command('list')
        .description('List deployed applications')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const deployments = await client.cloudHub2.getDeployments(orgId, env.id);

                if (deployments.length === 0) {
                    log.info(`No applications deployed in ${env.name}`);
                    return;
                }

                log.header(`Applications in ${env.name} (${deployments.length})`);

                printTable(
                    ['Name', 'Status', 'Version', 'Runtime', 'Replicas'],
                    deployments.map((d) => [
                        d.name,
                        d.status,
                        d.application?.ref?.version || '-',
                        d.target?.deploymentSettings?.runtime?.version || '-',
                        String(d.target?.replicas?.length || 0),
                    ])
                );
            } catch (error) {
                log.error(`Failed to list apps: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    apps
        .command('status')
        .description('Get detailed status of an application')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (appName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const deployment = await client.cloudHub2.findByName(orgId, env.id, appName);

                if (!deployment) {
                    log.error(`Application "${appName}" not found in ${env.name}`);
                    process.exit(1);
                }

                log.header(`${deployment.name}`);
                log.kv('Status', deployment.status);
                log.kv('Version', deployment.application?.ref?.version || '-');
                log.kv('Runtime', deployment.target?.deploymentSettings?.runtime?.version || '-');
                log.kv('Group ID', deployment.application?.ref?.groupId || '-');
                log.kv('Artifact ID', deployment.application?.ref?.artifactId || '-');

                if (deployment.target?.replicas) {
                    console.log();
                    log.bold('  Replicas:');
                    for (const replica of deployment.target.replicas) {
                        log.kv(`    ${replica.id}`, `${replica.state} (${replica.deploymentLocation || 'unknown'})`);
                    }
                }

                if (deployment.target?.deploymentSettings?.http?.inbound?.publicUrl) {
                    console.log();
                    log.kv('Public URL', deployment.target.deploymentSettings.http.inbound.publicUrl);
                }
            } catch (error) {
                log.error(`Failed to get status: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    return apps;
}
