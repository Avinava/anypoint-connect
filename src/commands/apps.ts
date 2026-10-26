/**
 * Apps CLI Commands
 * anc apps list | status | update | settings get|set | restart | stop | start | scale | delete
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printTable } from '../utils/formatter.js';
import { isProductionEnv, confirmProductionDeploy } from '../safety/guards.js';
import { buildApplicationDeletionPreview, deploymentIdMatches } from '../safety/deletion.js';
import { currentSettings } from '../safety/deployment.js';
import { looksSecret, redactRecord, redactText } from '../safety/secrets.js';
import {
    executeAppChange,
    planAppChange,
    resolveSettingsInput,
    type AppChangeRequest,
    type SettingsChangeInput,
} from '../workflows/app-change.js';
import { deploymentPhase, waitForAppPhase } from '../workflows/app-state.js';
import {
    addRolloutOptions,
    addRuntimeOptions,
    addSettingsOptions,
    confirmIfProduction,
    printAppChange,
    rolloutFromOptions,
    rolloutSpinner,
    runtimeFromOptions,
    settingsFromOptions,
} from './app-change-cli.js';
import { registerCompareCommand } from './compare.js';
import { createClient } from './shared.js';

type ChangeBuilder = (rollout: ReturnType<typeof rolloutFromOptions>) => Omit<
    AppChangeRequest,
    'orgId' | 'env' | 'appName' | 'settings' | 'secretValues'
> & {
    settings?: SettingsChangeInput;
};

/** Plan, preview, confirm and apply an application change from the CLI. */
async function runChangeCommand(
    appName: string,
    opts: {
        env: string;
        dryRun?: boolean;
        force?: boolean;
        stopStart?: boolean;
        updateStrategy?: string;
        wait?: boolean;
        timeout?: string;
    },
    build: ChangeBuilder,
    done: string,
): Promise<void> {
    let secretValues: string[] = [];
    try {
        const client = createClient();
        const orgId = await client.getDefaultOrgId();
        const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
        const rollout = rolloutFromOptions(opts);
        const { settings, ...change } = build(rollout);
        const resolved = resolveSettingsInput(settings);
        secretValues = resolved.secretValues;
        const plan = await planAppChange(client, {
            ...change,
            orgId,
            env,
            appName,
            settings: resolved.change,
            secretValues,
        });

        if (!printAppChange(plan)) {
            process.exitCode = 1;
            return;
        }
        if (plan.noop || opts.dryRun) {
            if (opts.dryRun) log.info('Dry run: nothing was changed.');
            return;
        }
        if (!(await confirmIfProduction(plan, Boolean(opts.force)))) {
            log.warn('Cancelled');
            return;
        }

        const { spinner, onStatus } = rolloutSpinner('Applying...');
        const result = await executeAppChange(client, plan, {
            wait: rollout.wait,
            timeoutMs: rollout.timeoutMs,
            onStatus,
        });
        if (!rollout.wait) {
            spinner.succeed(`${done} ${appName}: change accepted (${result.performed.join(', ')})`);
            log.dim(`  Follow it: anc apps status ${appName} --env ${opts.env} --wait`);
            return;
        }
        if (result.snapshot?.settled) {
            spinner.succeed(`${done} ${chalk.bold(appName)}: ${chalk.green(result.snapshot.phase)}`);
            return;
        }
        spinner.fail(
            `${appName}: ${result.snapshot?.phase ?? 'unknown'}${result.timedOut ? ' (timed out)' : ''}${result.snapshot?.reason ? ` - ${result.snapshot.reason}` : ''}`,
        );
        process.exitCode = 1;
    } catch (error) {
        log.error(redactText(errorMessage(error), secretValues));
        process.exitCode = 1;
    }
}

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
        .option('--wait', 'Poll until the app settles or fails', false)
        .option('--timeout <seconds>', 'Wait limit in seconds (default 300)')
        .action(async (appName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                let deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);

                if (!deployment) {
                    log.error(`Application "${appName}" not found in ${env.name}`);
                    process.exit(1);
                }

                let snapshot = deploymentPhase(deployment);
                if (opts.wait && !snapshot.terminal) {
                    const { spinner, onStatus } = rolloutSpinner(`Waiting for ${appName}...`);
                    const result = await waitForAppPhase(client.cloudHub2, orgId, env.id, deployment.id, {
                        sinceChange: deployment.lastModifiedDate,
                        timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) * 1000 : undefined,
                        onStatus: (s) => onStatus('status', s),
                    });
                    spinner.stop();
                    deployment = result.deployment;
                    snapshot = result.snapshot;
                }

                log.header(`${deployment.name}`);
                log.kv('Phase', `${snapshot.phase}${snapshot.reason ? ` (${snapshot.reason})` : ''}`);
                log.kv('Status', `${deployment.status}, desired ${deployment.application?.desiredState}`);
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
        .description('Restart an application: stop, wait until it is down, start')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('--no-wait', 'Return once the start is requested')
        .option('--timeout <seconds>', 'Wait limit in seconds (default 300)')
        .option('--dry-run', 'Show the steps, then stop', false)
        .option('--force', 'Skip production confirmation', false)
        .action(async (appName: string, opts) => {
            await runChangeCommand(appName, opts, () => ({ restart: true, mode: 'stopStart' }), 'Restarted');
        });

    addRolloutOptions(
        addSettingsOptions(
            addRuntimeOptions(
                apps
                    .command('update')
                    .description('Change artifact, runtime, properties and update strategy of an app in one update')
                    .argument('<appName>', 'Application name')
                    .requiredOption('-e, --env <name>', 'Environment name or ID')
                    .option('--version <version>', 'New artifact version')
                    .option('--artifact-id <id>', 'New artifact ID')
                    .option('--group-id <id>', 'New group ID'),
            ),
        ),
    )
        .option('--dry-run', 'Show the change, then stop', false)
        .option('--force', 'Skip production confirmation', false)
        .action(async (appName: string, opts) => {
            await runChangeCommand(
                appName,
                opts,
                (rollout) => ({
                    ref: { version: opts.version, artifactId: opts.artifactId, groupId: opts.groupId },
                    runtime: runtimeFromOptions(opts),
                    settings: settingsFromOptions(opts),
                    mode: rollout.mode,
                    updateStrategy: rollout.updateStrategy,
                }),
                'Updated',
            );
        });

    for (const [name, state] of [
        ['stop', 'STOPPED'],
        ['start', 'STARTED'],
    ] as const) {
        apps.command(name)
            .description(
                name === 'stop' ? 'Stop an application, keeping its deployment' : 'Start a stopped application',
            )
            .argument('<appName>', 'Application name')
            .requiredOption('-e, --env <name>', 'Environment name or ID')
            .option('--wait', 'Wait until the app settles', false)
            .option('--timeout <seconds>', 'Wait limit in seconds (default 300)')
            .option('--force', 'Skip production confirmation', false)
            .action(async (appName: string, opts) => {
                try {
                    const client = createClient();
                    const orgId = await client.getDefaultOrgId();
                    const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                    const deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);
                    if (!deployment) {
                        log.error(`Application "${appName}" not found in ${env.name}`);
                        process.exitCode = 1;
                        return;
                    }
                    if (isProductionEnv(env.name, env.isProduction) && !opts.force) {
                        if (!(await confirmProductionDeploy(env.name, env.isProduction))) {
                            log.warn(`${name} cancelled`);
                            return;
                        }
                    }
                    const sentAt = Date.now();
                    await client.cloudHub2.setDesiredState(orgId, env.id, deployment.id, state);
                    if (!opts.wait) {
                        log.success(`${name === 'stop' ? 'Stop' : 'Start'} requested for ${appName}`);
                        return;
                    }
                    const { spinner, onStatus } = rolloutSpinner(`Waiting for ${appName}...`);
                    const result = await waitForAppPhase(client.cloudHub2, orgId, env.id, deployment.id, {
                        sinceChange: sentAt,
                        timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) * 1000 : undefined,
                        onStatus: (s) => onStatus(name, s),
                    });
                    if (result.snapshot.settled) {
                        spinner.succeed(`${appName}: ${result.snapshot.phase}`);
                    } else {
                        spinner.fail(
                            `${appName}: ${result.snapshot.phase}${result.snapshot.reason ? ` - ${result.snapshot.reason}` : ''}`,
                        );
                        process.exitCode = 1;
                    }
                } catch (error) {
                    log.error(`${name} failed: ${errorMessage(error)}`);
                    process.exitCode = 1;
                }
            });
    }

    const settings = apps.command('settings').description('Read and change application properties');

    settings
        .command('get')
        .description('Show plain properties (secret-looking values masked) and secure property names')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('--reveal', 'Show secret-looking plain values unmasked', false)
        .action(async (appName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);
                if (!deployment) {
                    log.error(`Application "${appName}" not found in ${env.name}`);
                    process.exitCode = 1;
                    return;
                }
                const { properties, secureProperties } = currentSettings(deployment);
                const shown = opts.reveal ? properties : redactRecord(properties);
                log.header(`${deployment.name} in ${env.name}`);
                printTable(
                    ['Property', 'Value'],
                    Object.keys(shown)
                        .sort()
                        .map((key) => [key, shown[key]]),
                );
                if (Object.keys(secureProperties).length) {
                    console.log();
                    log.kv('Secure properties', Object.keys(secureProperties).sort().join(', '));
                }
                for (const key of Object.keys(properties).filter((k) => looksSecret(k))) {
                    log.warn(
                        `"${key}" looks like a secret but is stored as plain text. Fix: anc apps settings set ${appName} -e ${opts.env} --move-to-secure ${key}`,
                    );
                }
            } catch (error) {
                log.error(`Failed to read settings: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    addSettingsOptions(
        settings
            .command('set')
            .description(
                'Add, change, remove or move properties; secure values come only from files or environment variables',
            )
            .argument('<appName>', 'Application name')
            .requiredOption('-e, --env <name>', 'Environment name or ID'),
    )
        .option('--stop-start', 'Stop, apply, start: old and new replicas never run together', false)
        .option('--no-wait', 'Return once the change is accepted')
        .option('--timeout <seconds>', 'Wait limit in seconds (default 300)')
        .option('--dry-run', 'Show the change, then stop', false)
        .option('--force', 'Skip production confirmation', false)
        .action(async (appName: string, opts) => {
            await runChangeCommand(
                appName,
                opts,
                (rollout) => ({ settings: settingsFromOptions(opts), mode: rollout.mode }),
                'Updated settings of',
            );
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
                    const confirmed = await confirmProductionDeploy(env.name, env.isProduction);
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

    registerCompareCommand(apps);

    return apps;
}
