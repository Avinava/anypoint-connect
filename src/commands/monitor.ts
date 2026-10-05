/**
 * Monitor CLI Commands
 * anc monitor summary [--env <name>] [-a <app>] [--by app|worker|route] [--from <date>] [--to <date>]
 * anc monitor runtime --env <name> [-a <app>] [--from <date>] [--to <date>]
 * anc monitor trend --env <name> --signal <traffic|latency|memory|cpu|gc> [-a <app>] [-g <granularity>]
 * anc monitor query "<amql>" [--limit <n>] [--offset <n>]
 * anc monitor download --env <name> --from <date> [--to <date>] [--output <path>] [--format json|csv]
 */

import { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { parseDate } from '../utils/dates.js';
import { printTable, formatMs, formatDate, formatBytes } from '../utils/formatter.js';
import { createClient } from './shared.js';
import {
    AMQL_MAX_LIMIT,
    GRANULARITIES,
    TIME_SERIES_SIGNALS,
    isGranularity,
    type MetricsScope,
    type TimeSeriesPoint,
    type TimeSeriesSignal,
    type TrafficMetrics,
} from '../api/MonitoringApi.js';

interface WindowOptions {
    from?: string;
    to?: string;
}

function resolveWindow(opts: WindowOptions): { from: number; to: number } {
    const to = opts.to ? parseDate(opts.to) : Date.now();
    const from = opts.from ? parseDate(opts.from) : to - 24 * 60 * 60 * 1000;
    return { from, to };
}

function periodLabel(from: number, to: number): string {
    return `${new Date(from).toLocaleString()} → ${new Date(to).toLocaleString()}`;
}

function formatPercent(value: number | null | undefined, digits = 1): string {
    return value === null || value === undefined ? '-' : `${(value * 100).toFixed(digits)}%`;
}

function formatOptionalBytes(value: number | null | undefined): string {
    return value === null || value === undefined ? '-' : formatBytes(value);
}

function metricsToCSV(metrics: TrafficMetrics[]): string {
    const header =
        'App Name,Requests,Failed,Failure Rate,Avg Response Time (ms),p95 (ms),p99 (ms),Outbound Requests,Outbound Failed,Outbound Avg Response Time (ms),Messages';
    const rows = metrics.map((m) =>
        [
            m.appName,
            m.requestCount,
            m.failedCount,
            m.failureRate.toFixed(4),
            m.avgResponseTime.toFixed(1),
            m.p95,
            m.p99,
            m.outboundCount,
            m.outboundFailedCount,
            m.outboundAvgResponseTime.toFixed(1),
            m.messageCount,
        ].join(','),
    );
    return [header, ...rows].join('\n');
}

const SERIES_COLUMNS: Record<TimeSeriesSignal, Array<[string, string, (v: number) => string]>> = {
    traffic: [
        ['Requests', 'requestCount', String],
        ['Failed', 'failedCount', String],
        ['Avg', 'avgResponseTime', formatMs],
        ['p95', 'p95', formatMs],
    ],
    latency: [
        ['p50', 'p50', formatMs],
        ['p75', 'p75', formatMs],
        ['p90', 'p90', formatMs],
        ['p95', 'p95', formatMs],
        ['p99', 'p99', formatMs],
    ],
    memory: [
        ['Heap', 'heapUsed', formatBytes],
        ['Old Gen', 'oldGenUsed', formatBytes],
        ['Metaspace', 'metaspaceUsed', formatBytes],
    ],
    cpu: [
        ['System CPU', 'systemCpuLoad', (v) => formatPercent(v)],
        ['Process CPU', 'processCpuLoad', (v) => formatPercent(v)],
        ['Free RAM', 'freePhysicalMemory', formatBytes],
    ],
    gc: [
        ['Old-gen GCs', 'oldGenGcCount', String],
        ['Old-gen GC time', 'oldGenGcTimeMs', formatMs],
        ['All GCs', 'gcCount', String],
        ['All GC time', 'gcTimeMs', formatMs],
    ],
};

function seriesRow(point: TimeSeriesPoint, signal: TimeSeriesSignal, showWorker: boolean): string[] {
    const cells = SERIES_COLUMNS[signal].map(([, key, format]) => {
        const value = point[key];
        return value === null || value === undefined ? '-' : format(Number(value));
    });
    return [
        formatDate(point.timestamp),
        point.appName,
        ...(showWorker ? [String(point.workerId ?? '-')] : []),
        ...cells,
    ];
}

export function createMonitorCommand(): Command {
    const monitor = new Command('monitor').description(
        'Traffic, latency, JVM and host metrics from Anypoint Monitoring',
    );

    monitor
        .command('summary')
        .description('Traffic, failures and latency per app, worker or route (omit --env to compare environments)')
        .option('-e, --env <name>', 'Environment name or ID (default: every environment)')
        .option('-a, --app <name>', 'Filter by application name')
        .option('--by <grouping>', 'Group rows by app, worker or route', 'app')
        .option('--from <date>', 'Start time (default: 24h ago)')
        .option('--to <date>', 'End time (default: now)')
        .action(async (opts) => {
            try {
                if (!['app', 'worker', 'route'].includes(opts.by)) {
                    throw new Error(`Invalid --by "${opts.by}". Use: app, worker, route`);
                }
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = opts.env ? await client.accessManagement.resolveEnvironment(orgId, opts.env) : undefined;
                const { from, to } = resolveWindow(opts);
                const scope: MetricsScope = { orgId, envId: env?.id, from, to, appName: opts.app };
                const envColumn = env ? [] : ['Env'];
                const envCell = (row: { envName?: string }) => (env ? [] : [row.envName ?? '-']);

                log.header(`Metrics — ${env?.name ?? 'all environments'} (${periodLabel(from, to)})`);

                if (opts.by === 'route') {
                    const routes = await client.monitoring.getRouteMetrics(scope);
                    if (routes.length === 0) return log.warn('No traffic recorded for the specified period');
                    printTable(
                        ['Application', ...envColumn, 'Direction', 'Route', 'Requests', 'Failed', 'Avg', 'p95'],
                        routes.map((r) => [
                            r.appName,
                            ...envCell(r),
                            r.direction,
                            r.route ?? '(unlabelled)',
                            String(r.requestCount),
                            String(r.failedCount),
                            formatMs(r.avgResponseTime),
                            formatMs(r.p95),
                        ]),
                    );
                    return;
                }

                const rows = await client.monitoring.getMetrics(scope, opts.by);
                if (rows.length === 0) return log.warn('No traffic recorded for the specified period');
                printTable(
                    [
                        'Application',
                        ...envColumn,
                        ...(opts.by === 'worker' ? ['Worker'] : []),
                        'Requests',
                        'Failed',
                        'Avg',
                        'p50',
                        'p95',
                        'p99',
                        'Outbound',
                        'Out Failed',
                        'Messages',
                    ],
                    rows.map((m) => [
                        m.appName,
                        ...envCell(m),
                        ...(opts.by === 'worker' ? [m.workerId ?? '-'] : []),
                        String(m.requestCount),
                        m.failedCount ? `${m.failedCount} (${formatPercent(m.failureRate, 2)})` : '0',
                        formatMs(m.avgResponseTime),
                        formatMs(m.p50),
                        formatMs(m.p95),
                        formatMs(m.p99),
                        String(m.outboundCount),
                        String(m.outboundFailedCount),
                        String(m.messageCount),
                    ]),
                );
                console.log();
                log.kv(
                    'Total Requests',
                    rows.reduce((sum, m) => sum + m.requestCount, 0),
                );
                log.kv(
                    'Total Failed',
                    rows.reduce((sum, m) => sum + m.failedCount, 0),
                );
            } catch (error) {
                log.error(`Metrics failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('runtime')
        .description('JVM heap, old-generation pressure, GC activity and host CPU/RAM per worker')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('-a, --app <name>', 'Filter by application name')
        .option('--from <date>', 'Start time (default: 24h ago)')
        .option('--to <date>', 'End time (default: now)')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const { from, to } = resolveWindow(opts);

                const workers = await client.monitoring.getRuntimeMetrics({
                    orgId,
                    envId: env.id,
                    from,
                    to,
                    appName: opts.app,
                });
                if (workers.length === 0) return log.warn('No runtime metrics recorded for the specified period');

                log.header(`Runtime — ${env.name} (${periodLabel(from, to)})`);
                printTable(
                    [
                        'Application',
                        'Worker',
                        'Heap avg / peak',
                        'Old gen peak / limit',
                        'Old-gen GCs',
                        'GC time',
                        'CPU sys avg / max',
                        'Free RAM',
                    ],
                    workers.map((w) => [
                        w.appName,
                        w.workerId,
                        `${formatBytes(w.heapUsedAvg)} / ${formatBytes(w.heapUsedPeak)}`,
                        w.oldGenLimit
                            ? `${formatBytes(w.oldGenUsedPeak)} / ${formatBytes(w.oldGenLimit)} (${formatPercent(w.oldGenPeakRatio, 0)})`
                            : formatBytes(w.oldGenUsedPeak),
                        String(w.oldGenGcCount),
                        formatMs(w.oldGenGcTimeMs),
                        `${formatPercent(w.systemCpuLoadAvg)} / ${formatPercent(w.systemCpuLoadMax)}`,
                        `${formatOptionalBytes(w.freePhysicalMemoryAvg)} of ${formatOptionalBytes(w.totalPhysicalMemory)}`,
                    ]),
                );
            } catch (error) {
                log.error(`Runtime metrics failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('trend')
        .description('Bucketed time series for one signal')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .option('-s, --signal <signal>', `Signal: ${TIME_SERIES_SIGNALS.join(', ')}`, 'traffic')
        .option('-a, --app <name>', 'Filter by application name')
        .option('-g, --granularity <interval>', `Bucket size: ${GRANULARITIES.join(', ')}`, '1h')
        .option('--from <date>', 'Start time (default: 24h ago)')
        .option('--to <date>', 'End time (default: now)')
        .action(async (opts) => {
            try {
                if (!isGranularity(opts.granularity)) {
                    throw new Error(`Invalid granularity "${opts.granularity}". Use: ${GRANULARITIES.join(', ')}`);
                }
                if (!TIME_SERIES_SIGNALS.includes(opts.signal)) {
                    throw new Error(`Invalid signal "${opts.signal}". Use: ${TIME_SERIES_SIGNALS.join(', ')}`);
                }
                const signal = opts.signal as TimeSeriesSignal;
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const { from, to } = resolveWindow(opts);

                const points = await client.monitoring.getTimeSeries(
                    { orgId, envId: env.id, from, to, appName: opts.app },
                    signal,
                    opts.granularity,
                );
                if (points.length === 0) return log.warn('No data recorded for the specified period');

                const showWorker = points.some((p) => p.workerId !== undefined);
                log.header(`Trend (${signal}) — ${opts.app ?? 'all apps'} in ${env.name}, ${opts.granularity} buckets`);
                printTable(
                    [
                        'Time',
                        'Application',
                        ...(showWorker ? ['Worker'] : []),
                        ...SERIES_COLUMNS[signal].map(([label]) => label),
                    ],
                    points.map((p) => seriesRow(p, signal, showWorker)),
                );
            } catch (error) {
                log.error(`Trend failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    monitor
        .command('query')
        .description('Run a raw AMQL query and print the rows as JSON')
        .argument('<amql>', 'AMQL query string')
        .option('--limit <n>', `Rows per page (max ${AMQL_MAX_LIMIT})`, '200')
        .option('--offset <n>', 'Row offset', '0')
        .action(async (amql, opts) => {
            try {
                const client = createClient();
                const rows = await client.monitoring.search(amql, {
                    limit: parseInt(opts.limit, 10),
                    offset: parseInt(opts.offset, 10),
                });
                console.log(JSON.stringify(rows, null, 2));
            } catch (error) {
                log.error(errorMessage(error));
                process.exit(1);
            }
        });

    monitor
        .command('download')
        .description('Export per-app metrics for a period to a file')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .requiredOption('--from <date>', 'Start time')
        .option('--to <date>', 'End time (default: now)')
        .option('-o, --output <path>', 'Output file path')
        .option('-f, --format <fmt>', 'Output format (json|csv)', 'json')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, opts.env);
                const { from, to } = resolveWindow(opts);

                log.info(`Exporting metrics for ${chalk.bold(env.name)}`);
                log.kv('Period', `${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);

                const exported = await client.monitoring.exportMetrics(orgId, env.id, env.name, from, to);
                const ext = opts.format === 'csv' ? 'csv' : 'json';
                const content = ext === 'csv' ? metricsToCSV(exported.apps) : JSON.stringify(exported, null, 2);
                const output =
                    opts.output || `metrics-${env.name.toLowerCase()}-${new Date().toISOString().split('T')[0]}.${ext}`;

                fs.writeFileSync(output, content, 'utf-8');
                log.success(`Exported metrics for ${exported.apps.length} apps → ${chalk.bold(output)}`);
            } catch (error) {
                log.error(`Export failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    return monitor;
}
