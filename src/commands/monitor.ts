/**
 * Monitor CLI Commands
 * anc monitor <appName> --env <envName> [--from <date>] [--to <date>]
 * anc monitor download --env <envName> --from <date> --to <date> [--output <path>] [--format json|csv]
 */

import { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import { getConfig } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { printTable, formatMs } from '../utils/formatter.js';
import { AnypointClient } from '../client/AnypointClient.js';
import type { AppMetricsSummary } from '../api/MonitoringApi.js';

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
    if (isNaN(ts)) throw new Error(`Invalid date: "${dateStr}"`);
    return ts;
}

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
                log.error(`Metrics failed: ${error instanceof Error ? error.message : error}`);
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
                log.error(`Export failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    return monitor;
}
