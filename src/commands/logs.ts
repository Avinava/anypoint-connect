/**
 * Logs CLI Commands
 * anc logs tail <appName> --env <envName> [--level <level>]
 * anc logs download <appName> --env <envName> --from <date> --to <date> [--output <path>]
 */

import { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import { getConfig } from '../utils/config.js';
import { log } from '../utils/logger.js';
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

function parseDate(dateStr: string): number {
    // Support relative dates like "1h", "30m", "2d"
    const relativeMatch = dateStr.match(/^(\d+)(m|h|d)$/);
    if (relativeMatch) {
        const amount = parseInt(relativeMatch[1]);
        const unit = relativeMatch[2];
        const now = Date.now();
        switch (unit) {
            case 'm':
                return now - amount * 60 * 1000;
            case 'h':
                return now - amount * 60 * 60 * 1000;
            case 'd':
                return now - amount * 24 * 60 * 60 * 1000;
        }
    }

    const ts = Date.parse(dateStr);
    if (isNaN(ts)) {
        throw new Error(`Invalid date: "${dateStr}". Use ISO format or relative (e.g., 1h, 30m, 2d)`);
    }
    return ts;
}

export function createLogsCommand(): Command {
    const logs = new Command('logs').description('View and download application logs');

    logs.command('tail')
        .description('Stream logs in real-time')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name')
        .option('-l, --level <level>', 'Filter by log level (ERROR, WARN, INFO, DEBUG)')
        .option('-s, --search <text>', 'Search filter')
        .action(async (appName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                log.info(`Tailing logs for ${chalk.bold(appName)} in ${env.name}...`);
                log.dim('  Press Ctrl+C to stop\n');

                for await (const entries of client.logs.tailLogs(orgId, env.id, appName, {
                    level: opts.level,
                    search: opts.search,
                })) {
                    for (const entry of entries) {
                        const ts = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
                        log.logLine(entry.priority, entry.message, ts);
                    }
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
                    // Normal exit via Ctrl+C
                    return;
                }
                log.error(`Log tailing failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    logs.command('download')
        .description('Download logs for a time period')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name')
        .requiredOption('--from <date>', 'Start time (ISO date or relative: 1h, 30m, 2d)')
        .option('--to <date>', 'End time (default: now)')
        .option('-l, --level <level>', 'Filter by log level')
        .option('-o, --output <path>', 'Output file path')
        .action(async (appName: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const from = parseDate(opts.from);
                const to = opts.to ? parseDate(opts.to) : Date.now();

                log.info(`Downloading logs for ${chalk.bold(appName)} in ${env.name}`);
                log.kv('Period', `${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);

                const entries = await client.logs.getLogsForPeriod(orgId, env.id, appName, from, to, opts.level);

                if (entries.length === 0) {
                    log.warn('No log entries found for the specified period');
                    return;
                }

                // Format log lines
                const lines = entries.map((e) => {
                    const ts = new Date(e.timestamp).toISOString();
                    return `${ts} [${e.priority}] ${e.message}`;
                });

                const output = opts.output || `${appName}-logs-${new Date().toISOString().split('T')[0]}.log`;

                fs.writeFileSync(output, lines.join('\n'), 'utf-8');
                log.success(`Downloaded ${entries.length} log entries → ${chalk.bold(output)}`);
            } catch (error) {
                log.error(`Log download failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    return logs;
}
