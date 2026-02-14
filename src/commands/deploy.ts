/**
 * Deploy CLI Command
 * anc deploy <jarPath> --app <name> --env <envName> [--runtime <version>] [--replicas <n>] [--force]
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import chalk from 'chalk';
import { getConfig } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { AnypointClient } from '../client/AnypointClient.js';
import { isProductionEnv, buildDeploySummary, confirmProductionDeploy } from '../safety/guards.js';
import type { CreateDeploymentPayload } from '../api/CloudHub2Api.js';

function createClient(): AnypointClient {
    const config = getConfig();
    return new AnypointClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.callbackUrl,
        baseUrl: config.baseUrl,
    });
}

export function createDeployCommand(): Command {
    const deploy = new Command('deploy')
        .description('Deploy an application to CloudHub 2.0')
        .argument('[jarPath]', 'Path to the application JAR file')
        .requiredOption('-a, --app <name>', 'Application name')
        .requiredOption('-e, --env <name>', 'Target environment')
        .option('-r, --runtime <version>', 'Mule runtime version', '4.8.0')
        .option('--replicas <n>', 'Number of replicas', '1')
        .option('--group-id <id>', 'Maven group ID')
        .option('--artifact-id <id>', 'Maven artifact ID')
        .option('--version <v>', 'Application version')
        .option('--vcores <size>', 'vCore size (0.1, 0.2, 0.5, 1, 1.5, 2, 2.5, 3, 4)', '0.1')
        .option('--force', 'Skip production confirmation prompt', false)
        .action(async (jarPath: string | undefined, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                // Check for existing deployment
                const existing = await client.cloudHub2.findByName(orgId, env.id, opts.app);

                // If no JAR provided but app exists, show status
                if (!jarPath && existing) {
                    log.info('No JAR path provided. Showing current deployment status:');
                    log.kv('App', existing.name);
                    log.kv('Status', existing.status);
                    log.kv('Version', existing.application?.ref?.version || '-');
                    return;
                }

                if (!jarPath) {
                    log.error('JAR file path is required for new deployments');
                    process.exit(1);
                }

                // Validate JAR file
                const resolvedPath = path.resolve(jarPath);
                if (!fs.existsSync(resolvedPath)) {
                    log.error(`JAR file not found: ${resolvedPath}`);
                    process.exit(1);
                }

                if (!resolvedPath.endsWith('.jar')) {
                    log.error('File must have .jar extension');
                    process.exit(1);
                }

                const stat = fs.statSync(resolvedPath);
                if (stat.size === 0) {
                    log.error('JAR file is empty');
                    process.exit(1);
                }

                // Extract version from filename if not provided
                const basename = path.basename(resolvedPath);
                const match = basename.match(/^(.+?)-(\d+\.\d+\.\d+(?:-.+?)?)-mule-application\.jar$/);
                const artifactId = opts.artifactId || match?.[1] || opts.app;
                const version = opts.version || match?.[2] || '1.0.0';
                const groupId = opts.groupId || orgId;

                // ── Safety Check ─────────────────────────────────
                console.log(buildDeploySummary(opts.app, env.name, existing, version));

                if (isProductionEnv(env.name, env.isProduction) && !opts.force) {
                    const confirmed = await confirmProductionDeploy(env.name);
                    if (!confirmed) {
                        log.warn('Deployment cancelled');
                        return;
                    }
                }

                // ── Deploy ───────────────────────────────────────
                const spinner = ora('Deploying...').start();

                const payload: CreateDeploymentPayload = {
                    name: opts.app,
                    application: {
                        ref: {
                            groupId,
                            artifactId,
                            version,
                            packaging: 'jar',
                        },
                        desiredState: 'STARTED',
                    },
                    target: {
                        provider: 'MC',
                        targetId: 'cloudhub-us-east-2', // Default; could be made configurable
                        deploymentSettings: {
                            runtime: { version: opts.runtime },
                            http: { inbound: { publicUrl: `${opts.app}.us-e2.cloudhub.io` } },
                            clustered: false,
                            enforceDeployingReplicasAcrossNodes: false,
                            updateStrategy: 'rolling',
                        },
                        replicas: parseInt(opts.replicas) || 1,
                    },
                };

                let deployment;
                if (existing) {
                    spinner.text = 'Updating existing deployment...';
                    deployment = await client.cloudHub2.updateDeployment(orgId, env.id, existing.id, payload);
                } else {
                    spinner.text = 'Creating new deployment...';
                    deployment = await client.cloudHub2.createDeployment(orgId, env.id, payload);
                }

                // Poll for status
                spinner.text = 'Waiting for deployment to apply...';

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

                    spinner.succeed(`Deployed ${chalk.bold(opts.app)} v${version} → ${chalk.green(final.status)}`);
                } catch (err) {
                    spinner.fail(`Deployment issue: ${err instanceof Error ? err.message : err}`);
                    log.dim(`  Deployment ID: ${deployment.id}`);
                    log.dim(`  Check status: anc apps status ${opts.app} --env ${opts.env}`);
                    if (existing) {
                        log.dim(`  Previous version: ${existing.application?.ref?.version || 'unknown'}`);
                    }
                }
            } catch (error) {
                log.error(`Deploy failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    return deploy;
}
