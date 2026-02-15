/**
 * Monitor CLI Commands
 * anc monitor <appName> --env <envName> [--from <date>] [--to <date>]
 * anc monitor download --env <envName> --from <date> --to <date> [--output <path>] [--format json|csv]
 */

import { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { parseDate } from '../utils/dates.js';
import { printTable, formatMs } from '../utils/formatter.js';
import { createClient } from './shared.js';
import type { AppMetricsSummary } from '../api/MonitoringApi.js';

function metricsToCSV(metrics: AppMetricsSummary[]): string {
    const header =
        'App Name,Requests,Avg Response Time (ms),Errors,Error Rate (%),Outbound Requests,Outbound Avg Response Time (ms)';
    const rows = metrics.map(
        (m) =>
            `${m.appName},${m.requestCount},${m.avgResponseTime.toFixed(1)},${m.errorCount},${m.errorRate.toFixed(2)},${m.outboundCount},${m.outboundAvgResponseTime.toFixed(1)}`,
    );
    return [header, ...rows].join('\n');
}

export function createMonitorCommand(): Command {
    const monitor = new Command('monitor').description('View and export monitoring metrics');

    monitor
        .command('view')
        .description('View application metrics')
        .option('-a, --app <name>', 'Filter by application name')
        .requiredOption('-e, --env <name>', 'Environment name')
        .option('--from <date>', 'Start time (default: 24h ago)')
        .option('--to <date>', 'End time (default: now)')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const to = opts.to ? parseDate(opts.to) : Date.now();
                const from = opts.from ? parseDate(opts.from) : to - 24 * 60 * 60 * 1000;

                const metrics = await client.monitoring.getAppMetrics(orgId, env.id, from, to, opts.app);

                if (metrics.length === 0) {
                    log.warn('No metrics data available for the specified period');
                    return;
                }

                log.header(
                    `Metrics for ${env.name} (${new Date(from).toLocaleDateString()} → ${new Date(to).toLocaleDateString()})`,
                );

                printTable(
                    ['Application', 'Requests', 'Avg Response', 'Errors', 'Outbound', 'Outbound Avg'],
                    metrics.map((m) => [
                        m.appName,
                        String(m.requestCount),
                        formatMs(m.avgResponseTime),
                        String(m.errorCount),
                        String(m.outboundCount),
                        formatMs(m.outboundAvgResponseTime),
                    ]),
                );

                // Summary
                const totalReqs = metrics.reduce((sum, m) => sum + m.requestCount, 0);
                const totalErrors = metrics.reduce((sum, m) => sum + m.errorCount, 0);
                console.log();
                log.kv('Total Requests', totalReqs);
                log.kv('Total Errors', totalErrors);
                log.kv('Apps', metrics.length);
            } catch (error) {
                log.error(`Metrics failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('download')
        .description('Export monitoring data to file')
        .requiredOption('-e, --env <name>', 'Environment name')
        .requiredOption('--from <date>', 'Start time')
        .option('--to <date>', 'End time (default: now)')
        .option('-o, --output <path>', 'Output file path')
        .option('-f, --format <fmt>', 'Output format (json|csv)', 'json')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const to = opts.to ? parseDate(opts.to) : Date.now();
                const from = parseDate(opts.from);

                log.info(`Exporting metrics for ${chalk.bold(env.name)}`);
                log.kv('Period', `${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);

                const exported = await client.monitoring.exportMetrics(orgId, env.id, env.name, from, to);

                let content: string;
                let ext: string;

                if (opts.format === 'csv') {
                    content = metricsToCSV(exported.apps);
                    ext = 'csv';
                } else {
                    content = JSON.stringify(exported, null, 2);
                    ext = 'json';
                }

                const output =
                    opts.output || `metrics-${env.name.toLowerCase()}-${new Date().toISOString().split('T')[0]}.${ext}`;

                fs.writeFileSync(output, content, 'utf-8');
                log.success(`Exported ${exported.apps.length} apps metrics → ${chalk.bold(output)}`);
            } catch (error) {
                log.error(`Export failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    return monitor;
}
