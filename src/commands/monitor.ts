/**
 * Monitor CLI Commands
 * anc monitor view --env <envName> [-a <app>] [--from <date>] [--to <date>]
 * anc monitor perf --env <envName> [-a <app>]
 * anc monitor trend --env <envName> --app <app> [--granularity <5m|15m|30m|1h|1d>]
 * anc monitor workers --env <envName> [-a <app>]
 * anc monitor compare [--from <date>] [--to <date>]
 * anc monitor download --env <envName> --from <date> --to <date> [--output <path>] [--format json|csv]
 */

import { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { parseDate } from '../utils/dates.js';
import { printTable, formatMs, formatDate, formatBytes } from '../utils/formatter.js';
import { createClient } from './shared.js';
import type { AppMetricsSummary, TimeSeriesGranularity } from '../api/MonitoringApi.js';

const GRANULARITY_MAP: Record<string, TimeSeriesGranularity> = {
    '5m': 'PT5M',
    '15m': 'PT15M',
    '30m': 'PT30M',
    '1h': 'PT1H',
    '1d': 'P1D',
};

function metricsToCSV(metrics: AppMetricsSummary[]): string {
    const header = 'App Name,Requests,Avg Response Time (ms),Outbound Requests,Outbound Avg Response Time (ms)';
    const rows = metrics.map(
        (m) =>
            `${m.appName},${m.requestCount},${m.avgResponseTime.toFixed(1)},${m.outboundCount},${m.outboundAvgResponseTime.toFixed(1)}`,
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

                const [metrics, perf] = await Promise.all([
                    client.monitoring.getAppMetrics(orgId, env.id, from, to, opts.app),
                    client.monitoring.getPerformanceMetrics(orgId, env.id, from, to, opts.app),
                ]);

                if (metrics.length === 0) {
                    log.warn('No metrics data available for the specified period');
                    return;
                }

                const perfByApp = new Map(perf.map((p) => [p.appName, p]));

                log.header(
                    `Metrics for ${env.name} (${new Date(from).toLocaleDateString()} → ${new Date(to).toLocaleDateString()})`,
                );

                printTable(
                    ['Application', 'Requests', 'Avg Response', 'p95', 'p99', 'Outbound', 'Outbound Avg'],
                    metrics.map((m) => {
                        const p = perfByApp.get(m.appName);
                        return [
                            m.appName,
                            String(m.requestCount),
                            formatMs(m.avgResponseTime),
                            p ? formatMs(p.p95) : '-',
                            p ? formatMs(p.p99) : '-',
                            String(m.outboundCount),
                            formatMs(m.outboundAvgResponseTime),
                        ];
                    }),
                );

                const totalReqs = metrics.reduce((sum, m) => sum + m.requestCount, 0);
                console.log();
                log.kv('Total Requests', totalReqs);
                log.kv('Apps', metrics.length);
            } catch (error) {
                log.error(`Metrics failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('perf')
        .description('View percentile performance metrics (p50/p95/p99)')
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

                const metrics = await client.monitoring.getPerformanceMetrics(orgId, env.id, from, to, opts.app);

                if (metrics.length === 0) {
                    log.warn('No performance data available for the specified period');
                    return;
                }

                log.header(
                    `Performance — ${env.name} (${new Date(from).toLocaleDateString()} → ${new Date(to).toLocaleDateString()})`,
                );

                printTable(
                    ['Application', 'Requests', 'Avg', 'p50', 'p95', 'p99', 'Min', 'Max'],
                    metrics.map((m) => [
                        m.appName,
                        String(m.requestCount),
                        formatMs(m.avgResponseTime),
                        formatMs(m.p50),
                        formatMs(m.p95),
                        formatMs(m.p99),
                        formatMs(m.minResponseTime),
                        formatMs(m.maxResponseTime),
                    ]),
                );
            } catch (error) {
                log.error(`Performance metrics failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('trend')
        .description('View time-series metrics for an application')
        .requiredOption('-e, --env <name>', 'Environment name')
        .requiredOption('-a, --app <name>', 'Application name')
        .option('-g, --granularity <interval>', 'Time bucket size: 5m, 15m, 30m, 1h, 1d (default: 1h)', '1h')
        .option('--from <date>', 'Start time (default: 24h ago)')
        .option('--to <date>', 'End time (default: now)')
        .action(async (opts) => {
            try {
                const granularity = GRANULARITY_MAP[opts.granularity];
                if (!granularity) {
                    log.error(`Invalid granularity "${opts.granularity}". Use: 5m, 15m, 30m, 1h, 1d`);
                    process.exit(1);
                }

                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const to = opts.to ? parseDate(opts.to) : Date.now();
                const from = opts.from ? parseDate(opts.from) : to - 24 * 60 * 60 * 1000;

                const data = await client.monitoring.getTimeSeries(orgId, env.id, from, to, granularity, opts.app);

                if (data.length === 0) {
                    log.warn('No time-series data available for the specified period');
                    return;
                }

                log.header(`Trend — ${opts.app} in ${env.name} (${opts.granularity} buckets)`);

                printTable(
                    ['Time', 'Requests', 'Avg Response', 'p95'],
                    data.map((d) => [
                        formatDate(d.timestamp),
                        String(d.requestCount),
                        formatMs(d.avgResponseTime),
                        formatMs(d.p95),
                    ]),
                );
            } catch (error) {
                log.error(`Trend metrics failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('workers')
        .description('View per-worker/replica performance metrics')
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

                const metrics = await client.monitoring.getWorkerMetrics(orgId, env.id, from, to, opts.app);

                if (metrics.length === 0) {
                    log.warn('No worker metrics available for the specified period');
                    return;
                }

                log.header(
                    `Workers — ${env.name} (${new Date(from).toLocaleDateString()} → ${new Date(to).toLocaleDateString()})`,
                );

                printTable(
                    ['Application', 'Worker', 'Requests', 'Avg Response', 'p95', 'Max'],
                    metrics.map((m) => [
                        m.appName,
                        m.workerId,
                        String(m.requestCount),
                        formatMs(m.avgResponseTime),
                        formatMs(m.p95),
                        formatMs(m.maxResponseTime),
                    ]),
                );
            } catch (error) {
                log.error(`Worker metrics failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('compare')
        .description('Compare performance across all environments')
        .option('--from <date>', 'Start time (default: 24h ago)')
        .option('--to <date>', 'End time (default: now)')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();

                const to = opts.to ? parseDate(opts.to) : Date.now();
                const from = opts.from ? parseDate(opts.from) : to - 24 * 60 * 60 * 1000;

                const metrics = await client.monitoring.getCrossEnvMetrics(orgId, from, to);

                if (metrics.length === 0) {
                    log.warn('No cross-environment metrics available');
                    return;
                }

                log.header(
                    `Cross-Environment Comparison (${new Date(from).toLocaleDateString()} → ${new Date(to).toLocaleDateString()})`,
                );

                printTable(
                    ['Application', 'Environment', 'Requests', 'Avg Response', 'p95', 'p99'],
                    metrics.map((m) => [
                        m.appName,
                        m.envName,
                        String(m.requestCount),
                        formatMs(m.avgResponseTime),
                        formatMs(m.p95),
                        formatMs(m.p99),
                    ]),
                );
            } catch (error) {
                log.error(`Cross-env comparison failed: ${errorMessage(error)}`);
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

    monitor
        .command('memory')
        .description('View JVM memory usage, GC stats, and thread counts per app')
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

                const metrics = await client.monitoring.getMemoryMetrics(orgId, env.id, from, to, opts.app);

                if (metrics.length === 0) {
                    log.warn('No memory metrics available for the specified period');
                    return;
                }

                log.header(
                    `Memory — ${env.name} (${new Date(from).toLocaleDateString()} → ${new Date(to).toLocaleDateString()})`,
                );

                printTable(
                    ['Application', 'Heap Used', 'Heap Committed', 'Heap Max', 'GC Count', 'GC Time', 'Threads'],
                    metrics.map((m) => [
                        m.appName,
                        formatBytes(m.heapUsed),
                        formatBytes(m.heapCommitted),
                        formatBytes(m.heapMax),
                        String(Math.round(m.gcCount)),
                        formatMs(m.gcTime),
                        String(Math.round(m.threadCount)),
                    ]),
                );
            } catch (error) {
                log.error(`Memory metrics failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('memory-trend')
        .description('View JVM memory usage over time for an application')
        .requiredOption('-e, --env <name>', 'Environment name')
        .requiredOption('-a, --app <name>', 'Application name')
        .option('-g, --granularity <interval>', 'Time bucket size: 5m, 15m, 30m, 1h, 1d (default: 1h)', '1h')
        .option('--from <date>', 'Start time (default: 24h ago)')
        .option('--to <date>', 'End time (default: now)')
        .action(async (opts) => {
            try {
                const granularity = GRANULARITY_MAP[opts.granularity];
                if (!granularity) {
                    log.error(`Invalid granularity "${opts.granularity}". Use: 5m, 15m, 30m, 1h, 1d`);
                    process.exit(1);
                }

                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);

                const to = opts.to ? parseDate(opts.to) : Date.now();
                const from = opts.from ? parseDate(opts.from) : to - 24 * 60 * 60 * 1000;

                const data = await client.monitoring.getMemoryTimeSeries(
                    orgId,
                    env.id,
                    from,
                    to,
                    granularity,
                    opts.app,
                );

                if (data.length === 0) {
                    log.warn('No memory time-series data available for the specified period');
                    return;
                }

                log.header(`Memory Trend — ${opts.app} in ${env.name} (${opts.granularity} buckets)`);

                printTable(
                    ['Time', 'Heap Used', 'Heap Committed', 'GC Count'],
                    data.map((d) => [
                        formatDate(d.timestamp),
                        formatBytes(d.heapUsed),
                        formatBytes(d.heapCommitted),
                        String(Math.round(d.gcCount)),
                    ]),
                );
            } catch (error) {
                log.error(`Memory trend failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    return monitor;
}
