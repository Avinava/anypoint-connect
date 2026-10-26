/**
 * Deployed artifact comparison CLI command
 * anc apps compare <app> -e <env> (--repo <path> [--ref <ref>] [--working-tree] | --jar <path>)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { createClient } from './shared.js';
import { DEFAULT_JAR_MAX_BYTES } from '../api/ExchangeApi.js';
import {
    compareJarToGit,
    compareJarToJar,
    fetchDeployedJar,
    type ArtifactComparison,
    type PathDifference,
} from '../workflows/artifact-compare.js';

function printPaths(title: string, items: PathDifference[], total: number) {
    if (total === 0) return;
    log.bold(`${title} (${total})`);
    for (const item of items) {
        const sizes = [item.deployedSize, item.repoSize].filter((s) => s !== undefined).join(' -> ');
        console.log(
            `  ${item.path}${item.jarPath && item.jarPath !== item.path ? ` [${item.jarPath}]` : ''}  ${sizes}`,
        );
    }
    console.log();
}

function printComparison(comparison: ArtifactComparison) {
    log.kv('Verdict', comparison.verdict);
    log.kv('Version', `deployed ${comparison.pomVersion.deployed ?? '?'}, repo ${comparison.pomVersion.repo ?? '?'}`);
    if (comparison.sha256.repo) log.kv('SHA-256 match', String(comparison.sha256.match));
    log.kv('Compared entries', comparison.summary.compared);
    console.log();
    printPaths('Changed', comparison.changed, comparison.summary.changed);
    printPaths('Missing in repo', comparison.missingInRepo, comparison.summary.missingInRepo);
    printPaths('Extra in repo', comparison.extraInRepo, comparison.summary.extraInRepo);

    const deps = comparison.dependencies;
    if (deps.changed.length + deps.missingInRepo.length + deps.extraInRepo.length > 0) {
        log.bold('Dependencies');
        for (const d of deps.changed) console.log(`  ~ ${d.dependency}: ${d.deployed} -> ${d.repo}`);
        for (const d of deps.missingInRepo) console.log(`  - ${d} (deployed only)`);
        for (const d of deps.extraInRepo) console.log(`  + ${d} (repo only)`);
        console.log();
    }
    if (comparison.workingTreeChanges?.length) {
        log.bold(`Working tree changes (${comparison.workingTreeChanges.length})`);
        for (const c of comparison.workingTreeChanges) console.log(`  ${c.status.padEnd(2)} ${c.path}`);
        console.log();
    }
    for (const note of comparison.notes) log.dim(`  ${note}`);
}

/** Register `compare` under the `apps` command. */
export function registerCompareCommand(apps: Command): Command {
    return apps
        .command('compare')
        .description('Compare the deployed jar of an application with a git checkout or a local jar')
        .argument('<app>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('--repo <path>', 'Mule project directory (git checkout)')
        .option('--ref <ref>', 'Git commit, branch or tag to compare', 'HEAD')
        .option('--working-tree', 'Include uncommitted and untracked changes (based on HEAD)', false)
        .option('--jar <path>', 'Local application jar to compare instead of a repo')
        .action(async (appName: string, opts) => {
            try {
                if (Boolean(opts.repo) === Boolean(opts.jar)) throw new Error('Pass exactly one of --repo or --jar');

                let localJar: Buffer | undefined;
                if (opts.jar) {
                    const jarPath = path.resolve(opts.jar);
                    const stat = fs.statSync(jarPath);
                    if (!stat.isFile()) throw new Error(`Not a file: ${opts.jar}`);
                    if (stat.size > DEFAULT_JAR_MAX_BYTES)
                        throw new Error(`Jar exceeds ${DEFAULT_JAR_MAX_BYTES} bytes`);
                    localJar = fs.readFileSync(jarPath);
                }

                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const deployed = await fetchDeployedJar(client, orgId, env, appName, {
                    maxBytes: DEFAULT_JAR_MAX_BYTES,
                });

                log.header(`Compare ${appName} in ${env.name}`);
                log.kv('Deployed', `${deployed.ref.groupId}:${deployed.ref.artifactId}:${deployed.ref.version}`);
                if (!deployed.md5Matches) log.warn('Downloaded jar does not match the Exchange MD5');

                const comparison = localJar
                    ? compareJarToJar(deployed.buffer, localJar, opts.jar)
                    : await compareJarToGit(deployed.buffer, {
                          repoPath: opts.repo,
                          gitRef: opts.ref,
                          includeWorkingTree: opts.workingTree,
                      });
                printComparison(comparison);
                if (comparison.verdict === 'differs') process.exitCode = 1;
            } catch (error) {
                log.error(`Compare failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });
}
