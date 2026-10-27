/**
 * Logs CLI Commands
 * anc logs tail <appName> --env <envName> [--level <level>] [--search <text>]
 * anc logs search <appName> --env <envName> [--grep <text>] [--regex] [--logger <name>] [--since <1h|ISO>] [--previous-specs <n>]
 * anc logs download <appName> --env <envName> --from <date> [--to <date>] [--grep <text>] [--summary] [--output <path>] [--previous-specs <n>]
 * anc logs credentials <appName> --env <envName> [--since <date>] [--until <date>] [--previous-specs <n>] [--json]
 */

import { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { parseDate } from '../utils/dates.js';
import { printTable } from '../utils/formatter.js';
import { MAX_PREVIOUS_SPECS, type LogSource } from '../api/LogsApi.js';
import type { EnrichedLogEntry } from '../analysis/types.js';
import { MAX_LOG_LINES } from '../analysis/filter.js';
import { BUCKETS, type Bucket } from '../analysis/stats.js';
import { formatEntries, summarizeEntries, type LogSummary } from '../analysis/summary.js';
import { scanForCredentials } from '../analysis/credentials.js';
import { createClient } from './shared.js';

function parseLimit(value: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LOG_LINES) {
        throw new Error(`--limit must be a whole number from 1 to ${MAX_LOG_LINES}`);
    }
    return n;
}

const PREVIOUS_SPECS_FLAG = '--previous-specs <n>';
const PREVIOUS_SPECS_HELP = `Also read this many earlier deployment specs (max ${MAX_PREVIOUS_SPECS}), to see the generation an update replaced`;

function parsePreviousSpecs(value: string | undefined): number {
    const n = Number(value ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > MAX_PREVIOUS_SPECS) {
        throw new Error(`--previous-specs must be a whole number from 0 to ${MAX_PREVIOUS_SPECS}`);
    }
    return n;
}

function parseBucket(value: string): Bucket {
    if (!(value in BUCKETS)) throw new Error(`--bucket must be one of ${Object.keys(BUCKETS).join(', ')}`);
    return value as Bucket;
}

function warnFallback(source: LogSource): void {
    if (source.fallbackFromSpecId) {
        log.warn(
            `Spec ${source.fallbackFromSpecId} has no log lines yet; showing the last successful spec ${source.specId}`,
        );
    }
}

function printEntry(entry: EnrichedLogEntry): void {
    const ts = new Date(entry.timestamp).toISOString();
    const logger = entry.loggerName ? chalk.dim(`${entry.loggerName} - `) : '';
    log.logLine(entry.priority, `${logger}${entry.message ?? ''}`, ts);
    if (entry.stackTrace) log.dim(entry.stackTrace);
}

function printSummary(summary: LogSummary): void {
    log.header('Summary');
    log.kv('Entries', summary.totalEntries);
    if (summary.totalEntries === 0) return;
    log.kv('Time range', `${summary.timeRange.start} → ${summary.timeRange.end}`);
    log.kv('Error rate', `${summary.errorRate}%`);

    log.header('By level');
    printTable(
        ['Level', 'Count'],
        Object.entries(summary.byLevel)
            .sort((a, b) => b[1] - a[1])
            .map(([level, count]) => [level, String(count)]),
    );

    log.header(`Top loggers (${summary.loggerCount} in total)`);
    printTable(
        ['Logger', 'Count'],
        summary.byLogger.map(({ name, count }) => [name, String(count)]),
    );

    log.header(`By time (${summary.histogram.bucket} buckets)`);
    printTable(
        ['Bucket start', 'Total', 'ERROR', 'WARN'],
        summary.histogram.rows.map((row) => [
            row.start,
            String(row.total),
            String(row.byLevel.ERROR ?? 0),
            String(row.byLevel.WARN ?? 0),
        ]),
    );

    log.header('Top message templates');
    printTable(
        ['Count', 'Level', 'Template'],
        summary.topTemplates.map((t) => [String(t.count), t.level, t.template]),
    );
}

export function createLogsCommand(): Command {
    const logs = new Command('logs').description('View, search and download application logs');

    logs.command('tail')
        .description('Stream logs in real-time')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name')
        .option('-l, --level <level>', 'Minimum log level (TRACE, DEBUG, INFO, WARN, ERROR, FATAL)')
        .option('-s, --search <text>', 'Search filter')
        .option('--regex', 'Treat --search as a regular expression')
        .option('--logger <name>', 'Only entries whose logger name contains this text')
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
                    regex: opts.regex,
                    logger: opts.logger,
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
                log.error(`Log tailing failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    logs.command('search')
        .description('Search recent log entries; multi-line entries are matched and shown whole')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name')
        .option('-g, --grep <text>', 'Text to find in the message, logger, thread, stack trace or JSON payload')
        .option('--regex', 'Treat --grep as a case-insensitive regular expression')
        .option('--logger <name>', 'Only entries whose logger name contains this text')
        .option('-l, --level <level>', 'Minimum log level (TRACE, DEBUG, INFO, WARN, ERROR, FATAL)')
        .option('--since <date>', 'Only entries since this time (ISO date or relative: 30m, 1h, 2d)')
        .option('--until <date>', 'Only entries until this time (ISO date or relative)')
        .option('-n, --limit <n>', `Most recent matching entries to show (max ${MAX_LOG_LINES})`, '100')
        .option(PREVIOUS_SPECS_FLAG, PREVIOUS_SPECS_HELP)
        .option('--json', 'Print the result as JSON')
        .action(async (appName: string, opts) => {
            try {
                const limit = parseLimit(opts.limit);
                const previousSpecs = parsePreviousSpecs(opts.previousSpecs);
                const startTime = opts.since ? parseDate(opts.since) : undefined;
                const endTime = opts.until ? parseDate(opts.until) : undefined;

                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const result = await client.logs.searchLogs(orgId, env.id, appName, {
                    search: opts.grep,
                    regex: opts.regex,
                    logger: opts.logger,
                    level: opts.level,
                    startTime,
                    endTime,
                    limit,
                    previousSpecs,
                });

                if (opts.json) {
                    console.log(JSON.stringify(result, null, 2));
                    return;
                }

                warnFallback(result.source);
                if (result.total === 0) {
                    log.warn(`No matching log entries for ${appName} in ${env.name}`);
                    return;
                }
                // Oldest first reads naturally in a terminal.
                for (const entry of [...result.entries].reverse()) printEntry(entry);
                const shown = result.truncated
                    ? `Showing the newest ${result.returned} of ${result.total} matching entries`
                    : `${result.total} matching entries`;
                const specs = result.source.specIds?.join(', ') ?? result.source.specId;
                log.info(`${shown} (spec ${specs})`);
            } catch (error) {
                log.error(`Log search failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    logs.command('download')
        .description('Download logs for a time period, or summarize them')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name')
        .requiredOption('--from <date>', 'Start time (ISO date or relative: 1h, 30m, 2d)')
        .option('--to <date>', 'End time (default: now)')
        .option('-l, --level <level>', 'Minimum log level')
        .option('-g, --grep <text>', 'Only entries containing this text')
        .option('--regex', 'Treat --grep as a case-insensitive regular expression')
        .option('--logger <name>', 'Only entries whose logger name contains this text')
        .option('--summary', 'Print counts by level, logger and time, and the top message templates, instead of lines')
        .option('--bucket <size>', 'Time bucket for --summary: 5m, 15m or 1h', '1h')
        .option(PREVIOUS_SPECS_FLAG, PREVIOUS_SPECS_HELP)
        .option('-o, --output <path>', 'Output file path (with --summary, writes the summary as JSON)')
        .action(async (appName: string, opts) => {
            try {
                const bucket = parseBucket(opts.bucket);
                const previousSpecs = parsePreviousSpecs(opts.previousSpecs);
                const from = parseDate(opts.from);
                const to = opts.to ? parseDate(opts.to) : Date.now();

                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                log.info(`Downloading logs for ${chalk.bold(appName)} in ${env.name}`);
                log.kv('Period', `${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);

                const { entries, source } = await client.logs.queryLogs(
                    orgId,
                    env.id,
                    appName,
                    {
                        startTime: from,
                        endTime: to,
                        level: opts.level,
                        search: opts.grep,
                        regex: opts.regex,
                        logger: opts.logger,
                    },
                    { previousSpecs },
                );
                warnFallback(source);

                if (opts.summary) {
                    const summary = summarizeEntries(entries, { bucket });
                    printSummary(summary);
                    if (opts.output) {
                        fs.writeFileSync(opts.output, JSON.stringify(summary, null, 2), 'utf-8');
                        log.success(`Summary written → ${chalk.bold(opts.output)}`);
                    }
                    return;
                }

                if (entries.length === 0) {
                    log.warn('No log entries found for the specified period');
                    return;
                }

                const output = opts.output || `${appName}-logs-${new Date().toISOString().split('T')[0]}.log`;

                fs.writeFileSync(output, formatEntries(entries) + '\n', 'utf-8');
                log.success(`Downloaded ${entries.length} log entries → ${chalk.bold(output)}`);
            } catch (error) {
                log.error(`Log download failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    logs.command('credentials')
        .description('Count log lines carrying session or bearer credentials; never prints the lines or values')
        .argument('<appName>', 'Application name')
        .requiredOption('-e, --env <name>', 'Environment name')
        .option('--since <date>', 'Only lines since this time (ISO date or relative: 30m, 1h, 2d)')
        .option('--until <date>', 'Only lines until this time (ISO date or relative)')
        .option(PREVIOUS_SPECS_FLAG, PREVIOUS_SPECS_HELP)
        .option('--json', 'Print the counts as JSON')
        .action(async (appName: string, opts) => {
            try {
                const previousSpecs = parsePreviousSpecs(opts.previousSpecs);
                const startTime = opts.since ? parseDate(opts.since) : undefined;
                const endTime = opts.until ? parseDate(opts.until) : undefined;

                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const { parts, ...source } = await client.logs.getLogParts(orgId, env.id, appName, { previousSpecs });
                const scan = scanForCredentials(parts, { startTime, endTime });

                if (opts.json) {
                    console.log(JSON.stringify({ app: appName, environment: env.name, ...source, ...scan }, null, 2));
                } else {
                    warnFallback(source);
                    log.kv('Scanned lines', scan.scannedLines);
                    if (scan.clean) {
                        log.success(`No credential markers in ${appName} (${env.name})`);
                    } else {
                        log.warn(`${scan.linesWithMarkers} lines carry credential markers`);
                        printTable(
                            ['Marker', 'Lines'],
                            Object.entries(scan.byMarker)
                                .filter(([, n]) => n > 0)
                                .map(([id, n]) => [id, String(n)]),
                        );
                        printTable(
                            ['Spec', 'Replica', 'Lines'],
                            scan.bySpec.flatMap((spec) =>
                                spec.byReplica.map((r) => [spec.specId, r.replica, String(r.linesWithMarkers)]),
                            ),
                        );
                    }
                }
                if (!scan.clean) process.exitCode = 2;
            } catch (error) {
                log.error(`Credential scan failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    return logs;
}
