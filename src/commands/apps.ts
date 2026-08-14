/**
 * Apps CLI Commands
 * anc apps list | status
 */

import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printTable } from '../utils/formatter.js';
import { isProductionEnv, confirmProductionDeploy } from '../safety/guards.js';
import { buildApplicationDeletionPreview, deploymentIdMatches } from '../safety/deletion.js';
import { createClient } from './shared.js';

export function createAppsCommand(): Command {
    const apps = new Command('apps').description('Manage deployed applications');

    apps.command('list')
        .description('List deployed applications')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const deployments = await client.cloudHub2.getDetailedDeployments(orgId, env.id);

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
                        String(d.target?.replicas || 0),
                    ]),
                );
            } catch (error) {
                log.error(`Failed to list apps: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    apps.command('status')
        .description('Get detailed status of an application')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .action(async (appName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

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

                if (deployment.replicas) {
                    console.log();
                    log.bold('  Replicas:');
                    for (const [index, replica] of deployment.replicas.entries()) {
                        log.kv(
                            `    ${replica.id || `replica-${index + 1}`}`,
                            `${replica.state} (${replica.deploymentLocation || 'unknown'})`,
                        );
                    }
                }

                if (deployment.target?.deploymentSettings?.http?.inbound?.publicUrl) {
                    console.log();
                    log.kv('Public URL', deployment.target.deploymentSettings.http.inbound.publicUrl);
                }
            } catch (error) {
                log.error(`Failed to get status: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    apps.command('delete')
        .description(
            'Permanently delete an application deployment (dry run unless --confirm matches its deployment ID)',
        )
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('--confirm <deploymentId>', 'Delete only if the current deployment has this exact ID')
        .option('--allow-production', 'Explicitly allow deletion from a production environment', false)
        .action(async (appName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!deployment) {
                    if (opts.confirm) {
                        log.success(`Deployment is already absent from ${env.name}`);
                        return;
                    }
                    log.error(`Application "${appName}" not found in ${env.name}`);
                    process.exitCode = 1;
                    return;
                }

                const preview = buildApplicationDeletionPreview(deployment, env);

                if (!opts.confirm) {
                    log.header('Delete application deployment — dry run');
                    log.kv('App', preview.app);
                    log.kv('Environment', preview.environment);
                    log.kv('Deployment ID', preview.deploymentId);
                    log.kv('Status', preview.status);
                    log.kv(
                        'Artifact',
                        `${preview.artifactRef.groupId}:${preview.artifactRef.artifactId}:${preview.artifactRef.version}`,
                    );
                    log.kv('Runtime', preview.runtime || '-');
                    log.kv('Target', preview.targetId);
                    log.kv('Replicas', preview.replicas);
                    log.kv('Production', preview.production);
                    log.warn(
                        'This permanently deletes the deployment configuration. The Exchange artifact is preserved.',
                    );
                    log.info(
                        `Re-run with --confirm ${preview.deploymentId}${preview.production ? ' --allow-production' : ''}`,
                    );
                    return;
                }

                if (!deploymentIdMatches(opts.confirm, deployment.id)) {
                    log.error(
                        `Deletion refused: confirmation ID does not match the current deployment (${deployment.id}).`,
                    );
                    process.exitCode = 1;
                    return;
                }

                if (isProductionEnv(env.name, env.isProduction) && !opts.allowProduction) {
                    log.error('Deletion refused: production requires --allow-production.');
                    process.exitCode = 1;
                    return;
                }

                await client.cloudHub2.deleteDeployment(orgId, env.id, deployment.id);
                const verification = await client.cloudHub2.waitForDeploymentDeletion(
                    orgId,
                    env.id,
                    deployment.name,
                    deployment.id,
                );

                if (verification.replacementDeploymentId) {
                    log.error(
                        'The original deployment was deleted, but a new deployment with the same name was detected.',
                    );
                    process.exitCode = 1;
                    return;
                }

                if (!verification.verifiedAbsent) {
                    log.warn(
                        verification.deletionState
                            ? 'CloudHub marks the deployment as DELETED, but its tombstone remains visible in the list.'
                            : 'CloudHub accepted deletion, but absence was not verified within 60 seconds.',
                    );
                    return;
                }

                log.success(`Deleted deployment from ${env.name} and verified it is absent`);
            } catch (error) {
                log.error(`Delete failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    apps.command('restart')
        .description('Restart an application')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('--force', 'Skip production confirmation', false)
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

                if (isProductionEnv(env.name, env.isProduction) && !opts.force) {
                    const confirmed = await confirmProductionDeploy(env.name);
                    if (!confirmed) {
                        log.warn('Restart cancelled');
                        return;
                    }
                }

                log.info(`Restarting ${appName} in ${env.name}...`);
                await client.cloudHub2.restartApp(orgId, env.id, deployment.id);
                log.success(`Restart initiated for ${appName}`);
            } catch (error) {
                log.error(`Restart failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    apps.command('scale')
        .description('Scale application replicas')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .requiredOption('--replicas <n>', 'Number of replicas')
        .option('--force', 'Skip production confirmation', false)
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

                const replicas = parseInt(opts.replicas);
                if (isNaN(replicas) || replicas < 1) {
                    log.error('Replicas must be a positive integer');
                    process.exit(1);
                }

                if (isProductionEnv(env.name, env.isProduction) && !opts.force) {
                    const confirmed = await confirmProductionDeploy(env.name);
                    if (!confirmed) {
                        log.warn('Scale cancelled');
                        return;
                    }
                }

                log.info(`Scaling ${appName} to ${replicas} replica(s) in ${env.name}...`);
                await client.cloudHub2.scaleApp(orgId, env.id, deployment.id, replicas);
                log.success(`Scaled ${appName} to ${replicas} replica(s)`);
            } catch (error) {
                log.error(`Scale failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    return apps;
}
