/**
 * Deploy CLI Command
 * anc deploy <jarPath> --app <name> --env <envName> [--runtime <version>] [--replicas <n>] [--region <target>]
 *            [--vcores <size>] [--asset-id <id>] [--asset-version <v>] [--group-id <id>] [settings flags]
 *            [--stop-start] [--update-strategy <s>] [--no-wait] [--dry-run] [--force]
 *
 * Publishes the JAR to Exchange, then creates the deployment or, for an existing app, applies the
 * artifact change (plus any runtime or settings change) as one update.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { isProductionEnv, buildDeploySummary, confirmProductionDeploy } from '../safety/guards.js';
import { DEFAULT_REGION, DEFAULT_RUNTIME, DEFAULT_VCORES, VALID_VCORES } from '../safety/deployment.js';
import { redactText } from '../safety/secrets.js';
import { describeJarDeployment, executeJarDeployment, planJarDeployment } from '../workflows/jar-deployment.js';
import {
    addRolloutOptions,
    addRuntimeOptions,
    addSettingsOptions,
    printAppChange,
    rolloutFromOptions,
    rolloutSpinner,
    runtimeFromOptions,
    settingsFromOptions,
} from './app-change-cli.js';
import { createClient } from './shared.js';

export function createDeployCommand(): Command {
    const command = new Command('deploy')
        .description('Publish a Mule application JAR to Exchange and deploy it to CloudHub 2.0')
        .argument('<jarPath>', 'Path to the built application JAR')
        .requiredOption('-a, --app <name>', 'Application name')
        .requiredOption('-e, --env <name>', 'Target environment')
        .option('--asset-id <id>', "Exchange asset ID (default: naming convention, else the JAR's Maven artifactId)")
        .option(
            '--asset-version <v>',
            "Exchange asset version (default: naming convention, else the JAR's Maven version)",
        )
        .option('--group-id <id>', 'Exchange group ID (default: the organization ID)')
        .option('--replicas <n>', '[new app only] Number of replicas (default: 1)')
        .option('--vcores <size>', `[new app only] vCore size: ${VALID_VCORES.join(', ')} (default: ${DEFAULT_VCORES})`)
        .option('--region <target>', `[new app only] CloudHub 2.0 target (default: ${DEFAULT_REGION})`);
    addRuntimeOptions(command, `(new app default: ${DEFAULT_RUNTIME}) `);
    addSettingsOptions(command);
    addRolloutOptions(command);
    return command
        .option('--dry-run', 'Show what would be published and deployed, then stop', false)
        .option('--force', 'Skip the production confirmation prompt', false)
        .action(async (jarPath: string, opts) => {
            let secretValues: string[] = [];
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const rollout = rolloutFromOptions(opts);

                const plan = await planJarDeployment(client, {
                    jarPath,
                    appName: opts.app,
                    orgId,
                    env,
                    assetId: opts.assetId,
                    assetVersion: opts.assetVersion,
                    groupId: opts.groupId,
                    runtime: runtimeFromOptions(opts),
                    replicas: opts.replicas ? parseInt(opts.replicas, 10) : undefined,
                    region: opts.region,
                    vcores: opts.vcores,
                    settings: settingsFromOptions(opts),
                    mode: rollout.mode,
                    updateStrategy: rollout.updateStrategy,
                });
                secretValues = plan.secretValues;

                if (plan.rejectedSettings.length > 0) {
                    throw new Error(
                        `"${opts.app}" already exists in ${env.name}; region, vCores and replicas apply only to a new app. ` +
                            `Drop ${plan.rejectedSettings.map((s) => `--${s}`).join(', ')}.`,
                    );
                }

                const summary = describeJarDeployment(plan);
                console.log(buildDeploySummary(opts.app, env.name, plan.existing, plan.ref.version, env.isProduction));
                log.kv('Artifact', `${plan.ref.groupId}:${plan.ref.artifactId}:${plan.ref.version}`);
                log.kv(
                    'Naming',
                    `asset ID from ${summary.publish.naming.assetId}, version from ${summary.publish.naming.version}`,
                );
                if (plan.naming.deployedPattern) {
                    log.dim(
                        `  The deployed asset follows ${plan.naming.deployedPattern.assetId} @ ${plan.naming.deployedPattern.assetVersion}; set it as a project convention or pass --asset-id/--asset-version to use it.`,
                    );
                }
                log.kv('SHA-256', plan.artifact.sha256);
                let ok = true;
                if (plan.change) {
                    ok = printAppChange(plan.change);
                } else if (summary.deploy.action === 'create') {
                    log.kv('Mode', 'create deployment');
                    log.kv('Runtime', summary.deploy.runtime);
                    log.kv(
                        'Target',
                        `${summary.deploy.region}, ${summary.deploy.vcores} vCores x ${summary.deploy.replicas}`,
                    );
                }
                if (!ok) {
                    process.exitCode = 1;
                    return;
                }

                if (opts.dryRun) {
                    log.info('Dry run: nothing was published or deployed.');
                    return;
                }

                if (isProductionEnv(env.name, env.isProduction) && !opts.force) {
                    if (!(await confirmProductionDeploy(env.name, env.isProduction))) {
                        log.warn('Deployment cancelled');
                        return;
                    }
                }

                const { spinner, onStatus } = rolloutSpinner('Publishing to Exchange and deploying...');
                const result = await executeJarDeployment(client, plan, {
                    wait: rollout.wait,
                    timeoutMs: rollout.timeoutMs,
                    onStatus,
                });

                if (!rollout.wait) {
                    spinner.succeed(
                        `Published ${result.published.assetId} v${result.published.version}; change accepted`,
                    );
                    log.dim(`  Follow it: anc apps status ${opts.app} --env ${opts.env} --wait`);
                    return;
                }
                if (result.snapshot?.settled) {
                    spinner.succeed(
                        `Deployed ${chalk.bold(opts.app)} v${plan.ref.version}: ${chalk.green(result.snapshot.phase)}`,
                    );
                    return;
                }
                spinner.fail(
                    `Deployment did not settle: ${result.snapshot?.phase ?? 'unknown'}${result.timedOut ? ' (timed out)' : ''}${result.snapshot?.reason ? ` - ${result.snapshot.reason}` : ''}`,
                );
                log.dim(`  Deployment ID: ${result.deployment.id}`);
                log.dim(`  Check status: anc apps status ${opts.app} --env ${opts.env}`);
                if (plan.existing)
                    log.dim(`  Previous version: ${plan.existing.application?.ref?.version || 'unknown'}`);
                process.exitCode = 1;
            } catch (error) {
                log.error(`Deploy failed: ${redactText(errorMessage(error), secretValues)}`);
                process.exit(1);
            }
        });
}
