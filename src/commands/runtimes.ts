/**
 * Runtimes CLI Command
 * anc runtimes list -e <env> [--app <name> | --target <id>]
 */

import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printTable } from '../utils/formatter.js';
import { compareVersions, parseRuntimeString, resolveRuntime, suggestRuntimes } from '../safety/runtime.js';
import { createClient } from './shared.js';

export function createRuntimesCommand(): Command {
    const runtimes = new Command('runtimes').description('Mule runtime versions a deployment target accepts');

    runtimes
        .command('list')
        .description("List runtime versions for an app's target or a given target")
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('-a, --app <name>', "Use this app's target and check its current runtime")
        .option('--target <id>', 'Target ID, e.g. cloudhub-us-east-2 or a private space ID')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const app = opts.app ? await client.cloudHub2.findDetailByName(orgId, env.id, opts.app) : null;
                if (opts.app && !app) {
                    log.error(`Application "${opts.app}" not found in ${env.name}`);
                    process.exitCode = 1;
                    return;
                }
                const targetId: string | undefined = opts.target ?? app?.target?.targetId;
                if (!targetId) {
                    const targets = await client.runtimes.getTargets(orgId);
                    printTable(
                        ['Target', 'Name', 'Type', 'Versions'],
                        targets.map((t) => [t.id, t.name ?? '-', t.type ?? '-', String(t.runtimes.length)]),
                    );
                    return;
                }
                const target = await client.runtimes.getTarget(orgId, targetId);
                if (!target) {
                    log.error(`Target "${targetId}" is not in the organization's runtime catalog`);
                    process.exitCode = 1;
                    return;
                }
                log.header(`Runtimes on ${target.name ?? target.id}`);
                printTable(
                    ['Version', 'Channel', 'Java', 'Tag'],
                    [...target.runtimes]
                        .sort((a, b) => compareVersions(b.version, a.version))
                        .map((v) => [v.version, v.releaseChannel ?? '-', v.java.join(', ') || '-', v.tag ?? '-']),
                );
                const runtime = app?.target?.deploymentSettings?.runtime;
                if (runtime) {
                    const current = parseRuntimeString(runtime.version, runtime.java);
                    if (resolveRuntime(target.runtimes, current)) {
                        log.success(`${app?.name} runs ${runtime.version}, which this target still offers`);
                    } else {
                        log.warn(`${app?.name} runs ${runtime.version}, which this target no longer offers`);
                        log.info(`Nearest supported: ${suggestRuntimes(target.runtimes, current).join('; ')}`);
                        log.dim(`  anc apps update ${app?.name} -e ${opts.env} --runtime <version> --dry-run`);
                    }
                }
            } catch (error) {
                log.error(`Failed to list runtimes: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    return runtimes;
}
