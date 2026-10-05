/**
 * Deploy CLI Command
 * anc deploy <jarPath> --app <name> --env <envName> [--runtime <version>] [--replicas <n>] [--region <target>]
 *            [--vcores <size>] [--asset-id <id>] [--asset-version <v>] [--group-id <id>] [--dry-run] [--force]
 *
 * Publishes the JAR to Exchange using its embedded Maven identity, then creates the deployment
 * or — for an existing app — changes only its artifact reference.
 */

import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { isProductionEnv, buildDeploySummary, confirmProductionDeploy } from '../safety/guards.js';
import { DEFAULT_REGION, DEFAULT_RUNTIME, DEFAULT_VCORES, VALID_VCORES } from '../safety/deployment.js';
import { describeJarDeployment, executeJarDeployment, planJarDeployment } from '../workflows/jar-deployment.js';
import { createClient } from './shared.js';

export function createDeployCommand(): Command {
    return new Command('deploy')
        .description('Publish a Mule application JAR to Exchange and deploy it to CloudHub 2.0')
        .argument('<jarPath>', 'Path to the built application JAR')
        .requiredOption('-a, --app <name>', 'Application name')
        .requiredOption('-e, --env <name>', 'Target environment')
        .option('--asset-id <id>', 'Exchange asset ID (default: the JAR’s embedded Maven artifactId)')
        .option('--asset-version <v>', 'Exchange asset version (default: the JAR’s embedded Maven version)')
        .option('--group-id <id>', 'Exchange group ID (default: the organization ID)')
        .option('-r, --runtime <version>', `[new app only] Mule runtime version (default: ${DEFAULT_RUNTIME})`)
        .option('--replicas <n>', '[new app only] Number of replicas (default: 1)')
        .option('--vcores <size>', `[new app only] vCore size: ${VALID_VCORES.join(', ')} (default: ${DEFAULT_VCORES})`)
        .option('--region <target>', `[new app only] CloudHub 2.0 target (default: ${DEFAULT_REGION})`)
        .option('--dry-run', 'Show what would be published and deployed, then stop', false)
        .option('--force', 'Skip the production confirmation prompt', false)
        .action(async (jarPath: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const plan = await planJarDeployment(client, {
                    jarPath,
                    appName: opts.app,
                    orgId,
                    env,
                    assetId: opts.assetId,
                    assetVersion: opts.assetVersion,
                    groupId: opts.groupId,
                    runtime: opts.runtime,
                    replicas: opts.replicas ? parseInt(opts.replicas, 10) : undefined,
                    region: opts.region,
                    vcores: opts.vcores,
                });

                if (plan.rejectedSettings.length > 0) {
                    throw new Error(
                        `"${opts.app}" already exists in ${env.name}; deploy changes only its artifact. ` +
                            `Drop ${plan.rejectedSettings.map((s) => `--${s}`).join(', ')} or use \`anc apps\` to change settings.`,
                    );
                }

                const summary = describeJarDeployment(plan);
                console.log(buildDeploySummary(opts.app, env.name, plan.existing, plan.ref.version, env.isProduction));
                log.kv('Artifact', `${plan.ref.groupId}:${plan.ref.artifactId}:${plan.ref.version}`);
                log.kv('SHA-256', plan.artifact.sha256);
                log.kv('Mode', summary.deploy.mode === 'update' ? 'update artifact reference' : 'create deployment');
                if (summary.deploy.mode === 'create') {
                    log.kv('Runtime', summary.deploy.runtime);
                    log.kv(
                        'Target',
                        `${summary.deploy.region}, ${summary.deploy.vcores} vCores × ${summary.deploy.replicas}`,
                    );
                }

                if (opts.dryRun) {
                    log.info('Dry run — nothing was published or deployed.');
                    return;
                }

                if (isProductionEnv(env.name, env.isProduction) && !opts.force) {
                    if (!(await confirmProductionDeploy(env.name, env.isProduction))) {
                        log.warn('Deployment cancelled');
                        return;
                    }
                }

                const spinner = ora('Publishing to Exchange and deploying...').start();
                const { published, deployment } = await executeJarDeployment(client, plan);
                spinner.text = `Published ${published.assetId} v${published.version}; waiting for deployment...`;

                try {
                    const final = await client.cloudHub2.waitForDeployment(
                        orgId,
                        env.id,
                        deployment.id,
                        (status, replicas) => {
                            const replicaStates = replicas?.map((r) => r.state).join(', ') || 'unknown';
                            spinner.text = `Status: ${status} (replicas: ${replicaStates})`;
                        },
                    );
                    spinner.succeed(
                        `Deployed ${chalk.bold(opts.app)} v${plan.ref.version} → ${chalk.green(final.status)}`,
                    );
                } catch (err) {
                    spinner.fail(`Deployment issue: ${errorMessage(err)}`);
                    log.dim(`  Deployment ID: ${deployment.id}`);
                    log.dim(`  Check status: anc apps status ${opts.app} --env ${opts.env}`);
                    if (plan.existing) {
                        log.dim(`  Previous version: ${plan.existing.application?.ref?.version || 'unknown'}`);
                    }
                }
            } catch (error) {
                log.error(`Deploy failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });
}
