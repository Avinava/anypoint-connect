/**
 * Runtimes CLI Command
 * anc runtimes list -e <env> [--app <name> | --target <id>]
 */

import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printJson, printTable } from '../utils/formatter.js';
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
        .option('--json', 'Print the result as JSON')
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
                    if (opts.json) {
                        printJson(
                            targets.map((t) => ({
                                id: t.id,
                                name: t.name ?? null,
                                type: t.type ?? null,
                                runtimeCount: t.runtimes.length,
                            })),
                        );
                        return;
                    }
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
                const sorted = [...target.runtimes].sort((a, b) => compareVersions(b.version, a.version));
                const runtime = app?.target?.deploymentSettings?.runtime;
                if (opts.json) {
                    const current = runtime ? parseRuntimeString(runtime.version, runtime.java) : undefined;
                    const offered = current ? Boolean(resolveRuntime(target.runtimes, current)) : undefined;
                    printJson({
                        target: { id: target.id, name: target.name ?? null },
                        runtimes: sorted.map((v) => ({
                            version: v.version,
                            channel: v.releaseChannel ?? null,
                            java: v.java,
                            tag: v.tag ?? null,
                        })),
                        ...(app && runtime && current
                            ? {
                                  app: {
                                      name: app.name,
                                      runtime: runtime.version,
                                      offered,
                                      ...(offered ? {} : { suggestions: suggestRuntimes(target.runtimes, current) }),
                                  },
                              }
                            : {}),
                    });
                    return;
                }
                log.header(`Runtimes on ${target.name ?? target.id}`);
                printTable(
                    ['Version', 'Channel', 'Java', 'Tag'],
                    sorted.map((v) => [v.version, v.releaseChannel ?? '-', v.java.join(', ') || '-', v.tag ?? '-']),
                );
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
