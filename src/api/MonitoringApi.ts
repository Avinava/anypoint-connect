/**
 * Monitoring API
 * AMQL queries against the Anypoint Monitoring metrics search endpoint.
 *
 * Datasource notes (behaviour of the platform, not of this client):
 * - Traffic: "mulesoft.app.inbound" / "mulesoft.app.outbound" (requests, response_time,
 *   response.status = 'FAILED', http.route on outbound), "mulesoft.message" (total_count, error_count).
 * - JVM memory: "mulesoft.app.jvm.memory" is per pool ("total-heap", an old-generation pool such as
 *   "tenured_gen", eden, survivor, "metaspace", …) with usage / committed / "limit" (-1 = unbounded).
 * - GC: "mulesoft.app.jvm.gc" count and duration (ms) are cumulative counters per worker and collector,
 *   so the activity in a window is MAX − MIN, never SUM.
 * - Host: "mulesoft.app.jvm.cpu" (available_processors, total_physical_memory_size) and
 *   "mulesoft.app.memory" (system_cpu_load, process_cpu_load, free_physical_memory_size). MIN/MAX over
 *   the physical-memory size fields fail server-side (HTTP 500 after a long wait); only AVG is used.
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';
import { AmqlQueryError } from '../utils/errors.js';

/** Largest page the metrics search endpoint accepts. */
export const AMQL_MAX_LIMIT = 2000;
/** Hard cap on rows collected across pages by {@link MonitoringApi.searchAll}. */
const SEARCH_ALL_ROW_CAP = 20000;
/** Large windows on some datasources take well over the default HTTP timeout. */
const AMQL_TIMEOUT_MS = 90_000;

export type MetricRow = Record<string, number | string | null | undefined>;

export type Granularity = '1m' | '5m' | '15m' | '30m' | '1h' | '1d';

/** User-facing bucket sizes mapped to AMQL TIMESERIES durations. */
export const GRANULARITY: Record<Granularity, string> = {
    '1m': 'PT1M',
    '5m': 'PT5M',
    '15m': 'PT15M',
    '30m': 'PT30M',
    '1h': 'PT1H',
    '1d': 'P1D',
};

export const GRANULARITIES = Object.keys(GRANULARITY) as Granularity[];

export function isGranularity(value: string): value is Granularity {
    return value in GRANULARITY;
}

/** Quote a value as an AMQL string literal. */
export function amqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
    if (!UUID_PATTERN.test(value)) throw new Error(`Invalid ${label}: expected a UUID`);
}

export interface MetricsScope {
    orgId: string;
    /** Omit to cover every environment in the organization. */
    envId?: string;
    from: number;
    to: number;
    appName?: string;
}

export type MetricsGroupBy = 'app' | 'worker';

export interface TrafficMetrics {
    appName: string;
    /** Present when the scope spans all environments. */
    envName?: string;
    /** Present when grouped by worker. */
    workerId?: string;
    requestCount: number;
    failedCount: number;
    /** failedCount / requestCount, 0 when there were no requests. */
    failureRate: number;
    avgResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
    outboundCount: number;
    outboundFailedCount: number;
    outboundAvgResponseTime: number;
    messageCount: number;
    messageErrorCount: number;
}

export interface RouteMetrics {
    appName: string;
    envName?: string;
    direction: 'inbound' | 'outbound';
    /** `null` when the runtime did not label the route. */
    route: string | null;
    requestCount: number;
    failedCount: number;
    avgResponseTime: number;
    p95: number;
}

export interface MemoryPoolMetrics {
    pool: string;
    type: string;
    usedAvg: number;
    usedPeak: number;
    committedAvg: number;
    /** `null` when the pool is unbounded. */
    limit: number | null;
}

export interface GcCollectorMetrics {
    collector: string;
    oldGeneration: boolean;
    /** Collections inside the window (counter delta). */
    collections: number;
    /** Milliseconds spent collecting inside the window (counter delta). */
    timeMs: number;
}

export interface RuntimeMetrics {
    appName: string;
    workerId: string;
    heapUsedAvg: number;
    heapUsedPeak: number;
    heapCommittedAvg: number;
    /** Old-generation (tenured) pool — its post-GC baseline is the leak / pressure signal. */
    oldGenPool: string | null;
    oldGenUsedAvg: number;
    oldGenUsedPeak: number;
    oldGenLimit: number | null;
    /** oldGenUsedPeak / oldGenLimit, `null` when the pool is unbounded. */
    oldGenPeakRatio: number | null;
    metaspaceUsedAvg: number;
    oldGenGcCount: number;
    oldGenGcTimeMs: number;
    gcCollectors: GcCollectorMetrics[];
    pools: MemoryPoolMetrics[];
    availableProcessors: number | null;
    totalPhysicalMemory: number | null;
    freePhysicalMemoryAvg: number | null;
    systemCpuLoadAvg: number | null;
    systemCpuLoadMax: number | null;
    processCpuLoadAvg: number | null;
    processCpuLoadMax: number | null;
}

export type TimeSeriesSignal = 'traffic' | 'latency' | 'memory' | 'cpu' | 'gc';

export const TIME_SERIES_SIGNALS: TimeSeriesSignal[] = ['traffic', 'latency', 'memory', 'cpu', 'gc'];

export interface TimeSeriesPoint {
    timestamp: number;
    appName: string;
    workerId?: string;
    [metric: string]: number | string | null | undefined;
}

export interface MetricsExport {
    environment: string;
    period: { from: string; to: string };
    apps: TrafficMetrics[];
    summary: {
        totalRequests: number;
        totalFailed: number;
        avgResponseTime: number;
    };
}

interface SearchOptions {
    limit?: number;
    offset?: number;
}

interface SearchResponse {
    data?: MetricRow[];
    metadata?: { pagination?: { next?: string | null } };
}

const OLD_GENERATION_POOL = /old|tenured/i;
const OLD_GENERATION_COLLECTOR = /old|marksweep|mark sweep|full|major|tenured/i;

function num(value: MetricRow[string]): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: MetricRow[string]): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function str(value: MetricRow[string], fallback = 'Unknown'): string {
    return value === null || value === undefined || value === '' ? fallback : String(value);
}

export class MonitoringApi {
    private readonly baseUrl = '/observability/api/v1';

    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    /**
     * Execute one page of an AMQL query. Platform errors (syntax, unknown datasource or
     * attribute, oversized limit) are raised as {@link AmqlQueryError}, never hidden.
     */
    async search(query: string, options: SearchOptions = {}): Promise<MetricRow[]> {
        return (await this.searchPage(query, options)).data ?? [];
    }

    /** Execute an AMQL query and follow pagination until exhausted (capped). */
    async searchAll(query: string): Promise<MetricRow[]> {
        const rows: MetricRow[] = [];
        let offset = 0;
        for (;;) {
            const page = await this.searchPage(query, { limit: AMQL_MAX_LIMIT, offset });
            const data = page.data ?? [];
            rows.push(...data);
            offset += data.length;
            if (!page.metadata?.pagination?.next || data.length === 0 || rows.length >= SEARCH_ALL_ROW_CAP) {
                return rows;
            }
        }
    }

    private async searchPage(query: string, { limit = 200, offset = 0 }: SearchOptions): Promise<SearchResponse> {
        const pageSize = Math.min(Math.max(Math.trunc(limit) || 1, 1), AMQL_MAX_LIMIT);
        const pageOffset = Math.max(Math.trunc(offset) || 0, 0);
        try {
            return await this.http.post<SearchResponse>(
                `${this.baseUrl}/metrics:search?limit=${pageSize}&offset=${pageOffset}`,
                { query },
                { timeout: AMQL_TIMEOUT_MS },
            );
        } catch (error) {
            throw AmqlQueryError.from(error, query);
        }
    }

    /**
     * Traffic and latency per app (or per worker), with failures, outbound calls and message
     * volume merged in. Omitting `envId` compares every environment.
     */
    async getMetrics(scope: MetricsScope, groupBy: MetricsGroupBy = 'app'): Promise<TrafficMetrics[]> {
        const cacheKey = `mon:metrics:${this.scopeKey(scope)}:${groupBy}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const keys = this.groupKeys(scope, groupBy === 'worker');
            const where = this.where(scope);
            const failed = `${where} AND "response.status" = 'FAILED'`;
            const groupBySql = `GROUP BY ${keys.join(', ')}`;
            const select = keys.join(', ');

            const [inbound, inboundFailed, outbound, outboundFailed, messages] = await Promise.all([
                this.searchAll(
                    `SELECT COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", MIN(response_time) AS "min_response_time", MAX(response_time) AS "max_response_time", PERCENTILE(response_time, 0.5) AS "p50", PERCENTILE(response_time, 0.75) AS "p75", PERCENTILE(response_time, 0.9) AS "p90", PERCENTILE(response_time, 0.95) AS "p95", PERCENTILE(response_time, 0.99) AS "p99", ${select} FROM "mulesoft.app.inbound" WHERE ${where} ${groupBySql}`,
                ),
                this.searchAll(
                    `SELECT COUNT(requests) AS "failed_count", ${select} FROM "mulesoft.app.inbound" WHERE ${failed} ${groupBySql}`,
                ),
                this.searchAll(
                    `SELECT COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", ${select} FROM "mulesoft.app.outbound" WHERE ${where} ${groupBySql}`,
                ),
                this.searchAll(
                    `SELECT COUNT(requests) AS "failed_count", ${select} FROM "mulesoft.app.outbound" WHERE ${failed} ${groupBySql}`,
                ),
                this.searchAll(
                    `SELECT SUM(total_count) AS "message_count", SUM(error_count) AS "message_error_count", ${select} FROM "mulesoft.message" WHERE ${where} ${groupBySql}`,
                ),
            ]);

            const rows = new Map<string, TrafficMetrics>();
            const rowFor = (row: MetricRow): TrafficMetrics => {
                const key = keys.map((k) => str(row[k.replace(/"/g, '')], '')).join('\u0000');
                let entry = rows.get(key);
                if (!entry) {
                    entry = {
                        appName: str(row['app.name']),
                        ...(scope.envId ? {} : { envName: str(row['env.name']) }),
                        ...(groupBy === 'worker' ? { workerId: str(row['worker.id']) } : {}),
                        requestCount: 0,
                        failedCount: 0,
                        failureRate: 0,
                        avgResponseTime: 0,
                        minResponseTime: 0,
                        maxResponseTime: 0,
                        p50: 0,
                        p75: 0,
                        p90: 0,
                        p95: 0,
                        p99: 0,
                        outboundCount: 0,
                        outboundFailedCount: 0,
                        outboundAvgResponseTime: 0,
                        messageCount: 0,
                        messageErrorCount: 0,
                    };
                    rows.set(key, entry);
                }
                return entry;
            };

            for (const row of inbound) {
                Object.assign(rowFor(row), {
                    requestCount: num(row['request_count']),
                    avgResponseTime: num(row['avg_response_time']),
                    minResponseTime: num(row['min_response_time']),
                    maxResponseTime: num(row['max_response_time']),
                    p50: num(row['p50']),
                    p75: num(row['p75']),
                    p90: num(row['p90']),
                    p95: num(row['p95']),
                    p99: num(row['p99']),
                });
            }
            for (const row of inboundFailed) rowFor(row).failedCount = num(row['failed_count']);
            for (const row of outbound) {
                const entry = rowFor(row);
                entry.outboundCount = num(row['request_count']);
                entry.outboundAvgResponseTime = num(row['avg_response_time']);
            }
            for (const row of outboundFailed) rowFor(row).outboundFailedCount = num(row['failed_count']);
            for (const row of messages) {
                const entry = rowFor(row);
                entry.messageCount = num(row['message_count']);
                entry.messageErrorCount = num(row['message_error_count']);
            }

            const result = [...rows.values()];
            for (const entry of result) {
                entry.failureRate = entry.requestCount > 0 ? entry.failedCount / entry.requestCount : 0;
            }
            return result.sort((a, b) => b.requestCount - a.requestCount || a.appName.localeCompare(b.appName));
        });
    }

    /** Request and failure counts per HTTP route, inbound and outbound. */
    async getRouteMetrics(scope: MetricsScope): Promise<RouteMetrics[]> {
        const cacheKey = `mon:routes:${this.scopeKey(scope)}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const keys = [...this.groupKeys(scope, false), '"http.route"'];
            const where = this.where(scope);
            const failed = `${where} AND "response.status" = 'FAILED'`;
            const select = keys.join(', ');
            const groupBySql = `GROUP BY ${select}`;

            const directions = ['inbound', 'outbound'] as const;
            const results = await Promise.all(
                directions.flatMap((direction) => [
                    this.searchAll(
                        `SELECT COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", PERCENTILE(response_time, 0.95) AS "p95", ${select} FROM "mulesoft.app.${direction}" WHERE ${where} ${groupBySql}`,
                    ),
                    this.searchAll(
                        `SELECT COUNT(requests) AS "failed_count", ${select} FROM "mulesoft.app.${direction}" WHERE ${failed} ${groupBySql}`,
                    ),
                ]),
            );

            const rows = new Map<string, RouteMetrics>();
            directions.forEach((direction, i) => {
                const [totals, failures] = [results[i * 2], results[i * 2 + 1]];
                const rowFor = (row: MetricRow): RouteMetrics => {
                    const key = [direction, ...keys.map((k) => str(row[k.replace(/"/g, '')], ''))].join('\u0000');
                    let entry = rows.get(key);
                    if (!entry) {
                        const route = row['http.route'];
                        entry = {
                            appName: str(row['app.name']),
                            ...(scope.envId ? {} : { envName: str(row['env.name']) }),
                            direction,
                            route: route === null || route === undefined || route === '' ? null : String(route),
                            requestCount: 0,
                            failedCount: 0,
                            avgResponseTime: 0,
                            p95: 0,
                        };
                        rows.set(key, entry);
                    }
                    return entry;
                };
                for (const row of totals) {
                    Object.assign(rowFor(row), {
                        requestCount: num(row['request_count']),
                        avgResponseTime: num(row['avg_response_time']),
                        p95: num(row['p95']),
                    });
                }
                for (const row of failures) rowFor(row).failedCount = num(row['failed_count']);
            });

            return [...rows.values()].sort((a, b) => b.failedCount - a.failedCount || b.requestCount - a.requestCount);
        });
    }

    /** JVM heap, old-generation pressure, GC activity and host CPU/RAM per worker. */
    async getRuntimeMetrics(scope: MetricsScope & { envId: string }): Promise<RuntimeMetrics[]> {
        const cacheKey = `mon:runtime:${this.scopeKey(scope)}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const where = this.where(scope);
            const workerKeys = `"app.name", "worker.id"`;

            const [pools, gc, capacity, host] = await Promise.all([
                this.searchAll(
                    `SELECT AVG(usage) AS "used_avg", MAX(usage) AS "used_peak", AVG(committed) AS "committed_avg", MAX("limit") AS "limit_max", ${workerKeys}, "type", "pool" FROM "mulesoft.app.jvm.memory" WHERE ${where} GROUP BY ${workerKeys}, "type", "pool"`,
                ),
                this.searchAll(
                    `SELECT MAX(count) AS "count_max", MIN(count) AS "count_min", MAX(duration) AS "duration_max", MIN(duration) AS "duration_min", ${workerKeys}, name FROM "mulesoft.app.jvm.gc" WHERE ${where} GROUP BY ${workerKeys}, name`,
                ),
                this.searchAll(
                    `SELECT MAX(available_processors) AS "available_processors", AVG(total_physical_memory_size) AS "total_physical_memory", ${workerKeys} FROM "mulesoft.app.jvm.cpu" WHERE ${where} GROUP BY ${workerKeys}`,
                ),
                this.searchAll(
                    `SELECT AVG(system_cpu_load) AS "system_cpu_avg", MAX(system_cpu_load) AS "system_cpu_max", AVG(process_cpu_load) AS "process_cpu_avg", MAX(process_cpu_load) AS "process_cpu_max", AVG(free_physical_memory_size) AS "free_memory_avg", ${workerKeys} FROM "mulesoft.app.memory" WHERE ${where} GROUP BY ${workerKeys}`,
                ),
            ]);

            const workers = new Map<string, RuntimeMetrics>();
            const workerFor = (row: MetricRow): RuntimeMetrics => {
                const appName = str(row['app.name']);
                const workerId = str(row['worker.id']);
                const key = `${appName}\u0000${workerId}`;
                let entry = workers.get(key);
                if (!entry) {
                    entry = {
                        appName,
                        workerId,
                        heapUsedAvg: 0,
                        heapUsedPeak: 0,
                        heapCommittedAvg: 0,
                        oldGenPool: null,
                        oldGenUsedAvg: 0,
                        oldGenUsedPeak: 0,
                        oldGenLimit: null,
                        oldGenPeakRatio: null,
                        metaspaceUsedAvg: 0,
                        oldGenGcCount: 0,
                        oldGenGcTimeMs: 0,
                        gcCollectors: [],
                        pools: [],
                        availableProcessors: null,
                        totalPhysicalMemory: null,
                        freePhysicalMemoryAvg: null,
                        systemCpuLoadAvg: null,
                        systemCpuLoadMax: null,
                        processCpuLoadAvg: null,
                        processCpuLoadMax: null,
                    };
                    workers.set(key, entry);
                }
                return entry;
            };

            for (const row of pools) {
                if (row['pool'] === null || row['pool'] === undefined) continue;
                const limit = numOrNull(row['limit_max']);
                workerFor(row).pools.push({
                    pool: str(row['pool']),
                    type: str(row['type']),
                    usedAvg: num(row['used_avg']),
                    usedPeak: num(row['used_peak']),
                    committedAvg: num(row['committed_avg']),
                    limit: limit !== null && limit > 0 ? limit : null,
                });
            }

            for (const row of gc) {
                const countMax = numOrNull(row['count_max']);
                if (countMax === null) continue; // collector registered but never reported
                const collector = str(row['name']);
                workerFor(row).gcCollectors.push({
                    collector,
                    oldGeneration: OLD_GENERATION_COLLECTOR.test(collector),
                    collections: Math.max(countMax - num(row['count_min']), 0),
                    timeMs: Math.max(num(row['duration_max']) - num(row['duration_min']), 0),
                });
            }

            for (const row of capacity) {
                const entry = workerFor(row);
                entry.availableProcessors = numOrNull(row['available_processors']);
                entry.totalPhysicalMemory = numOrNull(row['total_physical_memory']);
            }

            for (const row of host) {
                Object.assign(workerFor(row), {
                    systemCpuLoadAvg: numOrNull(row['system_cpu_avg']),
                    systemCpuLoadMax: numOrNull(row['system_cpu_max']),
                    processCpuLoadAvg: numOrNull(row['process_cpu_avg']),
                    processCpuLoadMax: numOrNull(row['process_cpu_max']),
                    freePhysicalMemoryAvg: numOrNull(row['free_memory_avg']),
                });
            }

            for (const entry of workers.values()) {
                const heapPools = entry.pools.filter((p) => p.type === 'heap');
                const totalHeap = heapPools.find((p) => p.pool === 'total-heap');
                const partitions = heapPools.filter((p) => p.pool !== 'total-heap');
                entry.heapUsedAvg = totalHeap?.usedAvg ?? partitions.reduce((s, p) => s + p.usedAvg, 0);
                entry.heapUsedPeak = totalHeap?.usedPeak ?? partitions.reduce((s, p) => s + p.usedPeak, 0);
                entry.heapCommittedAvg = totalHeap?.committedAvg ?? partitions.reduce((s, p) => s + p.committedAvg, 0);

                const oldGen = partitions.find((p) => OLD_GENERATION_POOL.test(p.pool));
                if (oldGen) {
                    entry.oldGenPool = oldGen.pool;
                    entry.oldGenUsedAvg = oldGen.usedAvg;
                    entry.oldGenUsedPeak = oldGen.usedPeak;
                    entry.oldGenLimit = oldGen.limit;
                    entry.oldGenPeakRatio = oldGen.limit ? oldGen.usedPeak / oldGen.limit : null;
                }
                entry.metaspaceUsedAvg = entry.pools.find((p) => p.pool === 'metaspace')?.usedAvg ?? 0;

                for (const collector of entry.gcCollectors.filter((c) => c.oldGeneration)) {
                    entry.oldGenGcCount += collector.collections;
                    entry.oldGenGcTimeMs += collector.timeMs;
                }
                entry.pools.sort((a, b) => a.type.localeCompare(b.type) || a.pool.localeCompare(b.pool));
            }

            return [...workers.values()].sort(
                (a, b) => a.appName.localeCompare(b.appName) || a.workerId.localeCompare(b.workerId),
            );
        });
    }

    /**
     * Bucketed metrics for one signal:
     * - traffic: requests, failed, avg and p95 latency per app
     * - latency: p50 / p75 / p90 / p95 / p99 per app
     * - memory: heap, old-generation and metaspace usage per worker
     * - cpu: system and process CPU load and average free physical memory per worker
     * - gc: old-generation collections and GC time per worker (per-bucket deltas)
     */
    async getTimeSeries(
        scope: MetricsScope & { envId: string },
        signal: TimeSeriesSignal,
        granularity: Granularity = '1h',
    ): Promise<TimeSeriesPoint[]> {
        const cacheKey = `mon:ts:${this.scopeKey(scope)}:${signal}:${granularity}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const where = this.where(scope);
            const ts = `TIMESERIES ${GRANULARITY[granularity]}`;
            const app = `"app.name"`;
            const worker = `"app.name", "worker.id"`;

            switch (signal) {
                case 'traffic': {
                    const [totals, failures] = await Promise.all([
                        this.searchAll(
                            `SELECT timestamp, COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", PERCENTILE(response_time, 0.95) AS "p95", ${app} FROM "mulesoft.app.inbound" WHERE ${where} GROUP BY ${app} ${ts}`,
                        ),
                        this.searchAll(
                            `SELECT timestamp, COUNT(requests) AS "failed_count", ${app} FROM "mulesoft.app.inbound" WHERE ${where} AND "response.status" = 'FAILED' GROUP BY ${app} ${ts}`,
                        ),
                    ]);
                    return this.mergeSeries(
                        [
                            [
                                totals,
                                { requestCount: 'request_count', avgResponseTime: 'avg_response_time', p95: 'p95' },
                            ],
                            [failures, { failedCount: 'failed_count' }],
                        ],
                        false,
                        { requestCount: 0, failedCount: 0 },
                    );
                }
                case 'latency': {
                    const rows = await this.searchAll(
                        `SELECT timestamp, PERCENTILE(response_time, 0.5) AS "p50", PERCENTILE(response_time, 0.75) AS "p75", PERCENTILE(response_time, 0.9) AS "p90", PERCENTILE(response_time, 0.95) AS "p95", PERCENTILE(response_time, 0.99) AS "p99", ${app} FROM "mulesoft.app.inbound" WHERE ${where} GROUP BY ${app} ${ts}`,
                    );
                    return this.mergeSeries(
                        [[rows, { p50: 'p50', p75: 'p75', p90: 'p90', p95: 'p95', p99: 'p99' }]],
                        false,
                    );
                }
                case 'memory': {
                    const rows = await this.searchAll(
                        `SELECT timestamp, AVG(usage) AS "used", ${worker}, "pool" FROM "mulesoft.app.jvm.memory" WHERE ${where} GROUP BY ${worker}, "pool" ${ts}`,
                    );
                    const heap = rows.filter((r) => r['pool'] === 'total-heap');
                    const oldGen = rows.filter((r) => OLD_GENERATION_POOL.test(str(r['pool'], '')));
                    const metaspace = rows.filter((r) => r['pool'] === 'metaspace');
                    return this.mergeSeries(
                        [
                            [heap, { heapUsed: 'used' }],
                            [oldGen, { oldGenUsed: 'used' }],
                            [metaspace, { metaspaceUsed: 'used' }],
                        ],
                        true,
                    );
                }
                case 'cpu': {
                    const rows = await this.searchAll(
                        `SELECT timestamp, AVG(system_cpu_load) AS "system_cpu", AVG(process_cpu_load) AS "process_cpu", AVG(free_physical_memory_size) AS "free_memory", ${worker} FROM "mulesoft.app.memory" WHERE ${where} GROUP BY ${worker} ${ts}`,
                    );
                    return this.mergeSeries(
                        [
                            [
                                rows,
                                {
                                    systemCpuLoad: 'system_cpu',
                                    processCpuLoad: 'process_cpu',
                                    freePhysicalMemory: 'free_memory',
                                },
                            ],
                        ],
                        true,
                    );
                }
                case 'gc': {
                    const rows = await this.searchAll(
                        `SELECT timestamp, MAX(count) AS "count_max", MIN(count) AS "count_min", MAX(duration) AS "duration_max", MIN(duration) AS "duration_min", ${worker}, name FROM "mulesoft.app.jvm.gc" WHERE ${where} GROUP BY ${worker}, name ${ts}`,
                    );
                    return this.gcDeltas(rows);
                }
            }
        });
    }

    /** Build a metrics export for a period (one environment, every app). */
    async exportMetrics(
        orgId: string,
        envId: string,
        envName: string,
        from: number,
        to: number,
    ): Promise<MetricsExport> {
        const apps = await this.getMetrics({ orgId, envId, from, to });
        const totalRequests = apps.reduce((sum, m) => sum + m.requestCount, 0);
        const totalFailed = apps.reduce((sum, m) => sum + m.failedCount, 0);
        const avgResponseTime =
            totalRequests > 0
                ? apps.reduce((sum, m) => sum + m.avgResponseTime * m.requestCount, 0) / totalRequests
                : 0;

        return {
            environment: envName,
            period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
            apps,
            summary: { totalRequests, totalFailed, avgResponseTime },
        };
    }

    private where(scope: MetricsScope): string {
        assertUuid(scope.orgId, 'organization ID');
        const clauses = [`"sub_org.id" = ${amqlString(scope.orgId)}`];
        if (scope.envId) {
            assertUuid(scope.envId, 'environment ID');
            clauses.push(`"env.id" = ${amqlString(scope.envId)}`);
        }
        clauses.push(`timestamp BETWEEN ${Math.trunc(scope.from)} AND ${Math.trunc(scope.to)}`);
        if (scope.appName) clauses.push(`"app.name" = ${amqlString(scope.appName)}`);
        return clauses.join(' AND ');
    }

    private groupKeys(scope: MetricsScope, byWorker: boolean): string[] {
        return ['"app.name"', ...(scope.envId ? [] : ['"env.name"']), ...(byWorker ? ['"worker.id"'] : [])];
    }

    private scopeKey(scope: MetricsScope): string {
        return [scope.orgId, scope.envId ?? '*', scope.from, scope.to, scope.appName ?? ''].join(':');
    }

    /** Merge several bucketed result sets into one point per timestamp + app (+ worker). */
    private mergeSeries(
        sources: Array<[MetricRow[], Record<string, string>]>,
        byWorker: boolean,
        defaults: Record<string, number> = {},
    ): TimeSeriesPoint[] {
        const points = new Map<string, TimeSeriesPoint>();
        for (const [rows, fields] of sources) {
            for (const row of rows) {
                const timestamp = num(row['timestamp']);
                const appName = str(row['app.name']);
                const workerId = byWorker ? str(row['worker.id']) : undefined;
                const key = `${timestamp}\u0000${appName}\u0000${workerId ?? ''}`;
                let point = points.get(key);
                if (!point) {
                    point = { timestamp, appName, ...(byWorker ? { workerId } : {}), ...defaults };
                    points.set(key, point);
                }
                for (const [target, source] of Object.entries(fields)) point[target] = numOrNull(row[source]);
            }
        }
        return [...points.values()].sort(
            (a, b) =>
                a.timestamp - b.timestamp ||
                a.appName.localeCompare(b.appName) ||
                String(a.workerId ?? '').localeCompare(String(b.workerId ?? '')),
        );
    }

    /**
     * Turn cumulative GC counters into per-bucket activity. Each bucket's delta is measured from the
     * previous bucket's maximum, so collections that straddle a boundary are still counted; the first
     * bucket of a worker falls back to its own MAX − MIN.
     */
    private gcDeltas(rows: MetricRow[]): TimeSeriesPoint[] {
        const series = new Map<string, MetricRow[]>();
        for (const row of rows) {
            if (numOrNull(row['count_max']) === null) continue;
            const key = `${str(row['app.name'])}\u0000${str(row['worker.id'])}\u0000${str(row['name'])}`;
            const list = series.get(key) ?? [];
            list.push(row);
            series.set(key, list);
        }

        const points = new Map<string, TimeSeriesPoint>();
        for (const list of series.values()) {
            list.sort((a, b) => num(a['timestamp']) - num(b['timestamp']));
            let previousCount: number | null = null;
            let previousDuration: number | null = null;
            for (const row of list) {
                const countMax = num(row['count_max']);
                const durationMax = num(row['duration_max']);
                // A counter that goes backwards means the JVM restarted inside the worker.
                const countBase =
                    previousCount !== null && previousCount <= countMax ? previousCount : num(row['count_min']);
                const durationBase =
                    previousDuration !== null && previousDuration <= durationMax
                        ? previousDuration
                        : num(row['duration_min']);
                previousCount = countMax;
                previousDuration = durationMax;

                const collector = str(row['name']);
                const oldGeneration = OLD_GENERATION_COLLECTOR.test(collector);
                const timestamp = num(row['timestamp']);
                const appName = str(row['app.name']);
                const workerId = str(row['worker.id']);
                const key = `${timestamp}\u0000${appName}\u0000${workerId}`;
                let point = points.get(key);
                if (!point) {
                    point = {
                        timestamp,
                        appName,
                        workerId,
                        oldGenGcCount: 0,
                        oldGenGcTimeMs: 0,
                        gcCount: 0,
                        gcTimeMs: 0,
                    };
                    points.set(key, point);
                }
                const collections = Math.max(countMax - countBase, 0);
                const timeMs = Math.max(durationMax - durationBase, 0);
                point.gcCount = num(point.gcCount) + collections;
                point.gcTimeMs = num(point.gcTimeMs) + timeMs;
                if (oldGeneration) {
                    point.oldGenGcCount = num(point.oldGenGcCount) + collections;
                    point.oldGenGcTimeMs = num(point.oldGenGcTimeMs) + timeMs;
                }
            }
        }
        return [...points.values()].sort(
            (a, b) =>
                a.timestamp - b.timestamp ||
                a.appName.localeCompare(b.appName) ||
                String(a.workerId).localeCompare(String(b.workerId)),
        );
    }
}
