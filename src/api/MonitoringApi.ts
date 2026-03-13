/**
 * Monitoring API
 * AMQL-based metrics queries with configurable time ranges
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';

export interface MetricDataPoint {
    [key: string]: number | string | undefined;
    timestamp?: number;
}

export interface AppMetricsSummary {
    appName: string;
    requestCount: number;
    avgResponseTime: number;
    outboundCount: number;
    outboundAvgResponseTime: number;
}

export interface PerformanceMetrics {
    appName: string;
    requestCount: number;
    avgResponseTime: number;
    maxResponseTime: number;
    minResponseTime: number;
    p50: number;
    p95: number;
    p99: number;
}

export interface TimeSeriesDataPoint {
    timestamp: number;
    appName: string;
    requestCount: number;
    avgResponseTime: number;
    p95: number;
}

export interface WorkerMetrics {
    appName: string;
    workerId: string;
    requestCount: number;
    avgResponseTime: number;
    maxResponseTime: number;
    p95: number;
}

export interface CrossEnvMetrics {
    appName: string;
    envName: string;
    requestCount: number;
    avgResponseTime: number;
    p95: number;
    p99: number;
}

export interface MemoryMetrics {
    appName: string;
    heapUsed: number;
    heapCommitted: number;
    heapMax: number;
    gcCount: number;
    gcTime: number;
    threadCount: number;
}

export interface MemoryTimeSeriesPoint {
    timestamp: number;
    appName: string;
    heapUsed: number;
    heapCommitted: number;
    gcCount: number;
}

export interface MetricsExport {
    environment: string;
    period: { from: string; to: string };
    apps: AppMetricsSummary[];
    summary: {
        totalRequests: number;
        avgResponseTime: number;
    };
}

export type TimeSeriesGranularity = 'PT5M' | 'PT15M' | 'PT30M' | 'PT1H' | 'P1D';

export class MonitoringApi {
    private readonly baseUrl = '/observability/api/v1';

    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    /**
     * Execute an AMQL query
     */
    async search(query: string, limit = 200): Promise<MetricDataPoint[]> {
        try {
            const response = await this.http.post<{ data: MetricDataPoint[] }>(
                `${this.baseUrl}/metrics:search?limit=${limit}&offset=0`,
                { query },
            );
            return response.data || [];
        } catch {
            return [];
        }
    }

    /**
     * Get inbound metrics for a time range.
     * Note: orgId, envId, and timestamps are system-controlled values from the
     * Anypoint Platform API — not user input — so string interpolation is safe here.
     */
    async getInboundMetrics(
        orgId: string,
        envId: string,
        from: number,
        to: number,
    ): Promise<Array<{ appName: string; requestCount: number; avgResponseTime: number }>> {
        const cacheKey = `mon:inbound:${orgId}:${envId}:${from}:${to}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const query = `SELECT COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", "app.name" FROM "mulesoft.app.inbound" WHERE "sub_org.id" = '${orgId}' AND "env.id" = '${envId}' AND timestamp BETWEEN ${from} AND ${to} GROUP BY "app.name"`;

            const data = await this.search(query);
            return data.map((row) => ({
                appName: String(row['app.name'] || 'Unknown'),
                requestCount: Number(row['request_count'] || 0),
                avgResponseTime: Number(row['avg_response_time'] || 0),
            }));
        });
    }

    /**
     * Get outbound metrics for a time range
     */
    async getOutboundMetrics(
        orgId: string,
        envId: string,
        from: number,
        to: number,
    ): Promise<Array<{ appName: string; requestCount: number; avgResponseTime: number }>> {
        const cacheKey = `mon:outbound:${orgId}:${envId}:${from}:${to}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const query = `SELECT COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", "app.name" FROM "mulesoft.app.outbound" WHERE "sub_org.id" = '${orgId}' AND "env.id" = '${envId}' AND timestamp BETWEEN ${from} AND ${to} GROUP BY "app.name"`;

            const data = await this.search(query);
            return data.map((row) => ({
                appName: String(row['app.name'] || 'Unknown'),
                requestCount: Number(row['request_count'] || 0),
                avgResponseTime: Number(row['avg_response_time'] || 0),
            }));
        });
    }

    /**
     * Get combined app metrics for a time range
     */
    async getAppMetrics(
        orgId: string,
        envId: string,
        from: number,
        to: number,
        appName?: string,
    ): Promise<AppMetricsSummary[]> {
        const [inbound, outbound] = await Promise.all([
            this.getInboundMetrics(orgId, envId, from, to),
            this.getOutboundMetrics(orgId, envId, from, to),
        ]);

        const outboundByApp = new Map(outbound.map((o) => [o.appName, o]));

        let results = inbound.map((row) => {
            const ob = outboundByApp.get(row.appName);
            return {
                appName: row.appName,
                requestCount: row.requestCount,
                avgResponseTime: row.avgResponseTime,
                outboundCount: ob?.requestCount || 0,
                outboundAvgResponseTime: ob?.avgResponseTime || 0,
            };
        });

        // Add outbound-only apps
        for (const ob of outbound) {
            if (!inbound.some((ib) => ib.appName === ob.appName)) {
                results.push({
                    appName: ob.appName,
                    requestCount: 0,
                    avgResponseTime: 0,
                    outboundCount: ob.requestCount,
                    outboundAvgResponseTime: ob.avgResponseTime,
                });
            }
        }

        if (appName) {
            results = results.filter((r) => r.appName.toLowerCase() === appName.toLowerCase());
        }

        return results;
    }

    /**
     * Get percentile-based performance metrics per app
     */
    async getPerformanceMetrics(
        orgId: string,
        envId: string,
        from: number,
        to: number,
        appName?: string,
    ): Promise<PerformanceMetrics[]> {
        const cacheKey = `mon:perf:${orgId}:${envId}:${from}:${to}:${appName || ''}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            let query = `SELECT COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", MAX(response_time) AS "max_response_time", MIN(response_time) AS "min_response_time", PERCENTILE(response_time, 0.5) AS "p50", PERCENTILE(response_time, 0.95) AS "p95", PERCENTILE(response_time, 0.99) AS "p99", "app.name" FROM "mulesoft.app.inbound" WHERE "sub_org.id" = '${orgId}' AND "env.id" = '${envId}' AND timestamp BETWEEN ${from} AND ${to}`;

            if (appName) {
                query += ` AND "app.name" = '${appName}'`;
            }
            query += ` GROUP BY "app.name"`;

            const data = await this.search(query);
            return data.map((row) => ({
                appName: String(row['app.name'] || 'Unknown'),
                requestCount: Number(row['request_count'] || 0),
                avgResponseTime: Number(row['avg_response_time'] || 0),
                maxResponseTime: Number(row['max_response_time'] || 0),
                minResponseTime: Number(row['min_response_time'] || 0),
                p50: Number(row['p50'] || 0),
                p95: Number(row['p95'] || 0),
                p99: Number(row['p99'] || 0),
            }));
        });
    }

    /**
     * Get time-series metrics for trending analysis
     */
    async getTimeSeries(
        orgId: string,
        envId: string,
        from: number,
        to: number,
        granularity: TimeSeriesGranularity = 'PT1H',
        appName?: string,
    ): Promise<TimeSeriesDataPoint[]> {
        const cacheKey = `mon:ts:${orgId}:${envId}:${from}:${to}:${granularity}:${appName || ''}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            let query = `SELECT timestamp, COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", PERCENTILE(response_time, 0.95) AS "p95", "app.name" FROM "mulesoft.app.inbound" WHERE "sub_org.id" = '${orgId}' AND "env.id" = '${envId}' AND timestamp BETWEEN ${from} AND ${to}`;

            if (appName) {
                query += ` AND "app.name" = '${appName}'`;
            }
            query += ` GROUP BY "app.name" TIMESERIES ${granularity}`;

            const data = await this.search(query, 1000);
            return data.map((row) => ({
                timestamp: Number(row['timestamp'] || 0),
                appName: String(row['app.name'] || 'Unknown'),
                requestCount: Number(row['request_count'] || 0),
                avgResponseTime: Number(row['avg_response_time'] || 0),
                p95: Number(row['p95'] || 0),
            }));
        });
    }

    /**
     * Get per-worker/replica performance metrics
     */
    async getWorkerMetrics(
        orgId: string,
        envId: string,
        from: number,
        to: number,
        appName?: string,
    ): Promise<WorkerMetrics[]> {
        const cacheKey = `mon:workers:${orgId}:${envId}:${from}:${to}:${appName || ''}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            let query = `SELECT COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", MAX(response_time) AS "max_response_time", PERCENTILE(response_time, 0.95) AS "p95", "app.name", "worker.id" FROM "mulesoft.app.inbound" WHERE "sub_org.id" = '${orgId}' AND "env.id" = '${envId}' AND timestamp BETWEEN ${from} AND ${to}`;

            if (appName) {
                query += ` AND "app.name" = '${appName}'`;
            }
            query += ` GROUP BY "app.name", "worker.id"`;

            const data = await this.search(query, 500);
            return data.map((row) => ({
                appName: String(row['app.name'] || 'Unknown'),
                workerId: String(row['worker.id'] || 'Unknown'),
                requestCount: Number(row['request_count'] || 0),
                avgResponseTime: Number(row['avg_response_time'] || 0),
                maxResponseTime: Number(row['max_response_time'] || 0),
                p95: Number(row['p95'] || 0),
            }));
        });
    }

    /**
     * Get JVM memory metrics per app (heap, GC, threads)
     * Queries the mulesoft.jvm datasource
     */
    async getMemoryMetrics(
        orgId: string,
        envId: string,
        from: number,
        to: number,
        appName?: string,
    ): Promise<MemoryMetrics[]> {
        const cacheKey = `mon:memory:${orgId}:${envId}:${from}:${to}:${appName || ''}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            let query = `SELECT AVG(heap_used) AS "heap_used", AVG(heap_committed) AS "heap_committed", MAX(heap_total) AS "heap_max", SUM("gc.count") AS "gc_count", AVG("gc.time") AS "gc_time", AVG(thread_count) AS "thread_count", "app.name" FROM "mulesoft.jvm" WHERE "sub_org.id" = '${orgId}' AND "env.id" = '${envId}' AND timestamp BETWEEN ${from} AND ${to}`;

            if (appName) {
                query += ` AND "app.name" = '${appName}'`;
            }
            query += ` GROUP BY "app.name"`;

            const data = await this.search(query);
            return data.map((row) => ({
                appName: String(row['app.name'] || 'Unknown'),
                heapUsed: Number(row['heap_used'] || 0),
                heapCommitted: Number(row['heap_committed'] || 0),
                heapMax: Number(row['heap_max'] || 0),
                gcCount: Number(row['gc_count'] || 0),
                gcTime: Number(row['gc_time'] || 0),
                threadCount: Number(row['thread_count'] || 0),
            }));
        });
    }

    /**
     * Get JVM memory time-series for trending analysis
     * Queries the mulesoft.jvm datasource with TIMESERIES
     */
    async getMemoryTimeSeries(
        orgId: string,
        envId: string,
        from: number,
        to: number,
        granularity: TimeSeriesGranularity = 'PT1H',
        appName?: string,
    ): Promise<MemoryTimeSeriesPoint[]> {
        const cacheKey = `mon:memts:${orgId}:${envId}:${from}:${to}:${granularity}:${appName || ''}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            let query = `SELECT timestamp, AVG(heap_used) AS "heap_used", AVG(heap_committed) AS "heap_committed", SUM("gc.count") AS "gc_count", "app.name" FROM "mulesoft.jvm" WHERE "sub_org.id" = '${orgId}' AND "env.id" = '${envId}' AND timestamp BETWEEN ${from} AND ${to}`;

            if (appName) {
                query += ` AND "app.name" = '${appName}'`;
            }
            query += ` GROUP BY "app.name" TIMESERIES ${granularity}`;

            const data = await this.search(query, 1000);
            return data.map((row) => ({
                timestamp: Number(row['timestamp'] || 0),
                appName: String(row['app.name'] || 'Unknown'),
                heapUsed: Number(row['heap_used'] || 0),
                heapCommitted: Number(row['heap_committed'] || 0),
                gcCount: Number(row['gc_count'] || 0),
            }));
        });
    }

    /**
     * Get cross-environment metrics comparison (no env filter)
     */
    async getCrossEnvMetrics(orgId: string, from: number, to: number): Promise<CrossEnvMetrics[]> {
        const cacheKey = `mon:crossenv:${orgId}:${from}:${to}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const query = `SELECT COUNT(requests) AS "request_count", AVG(response_time) AS "avg_response_time", PERCENTILE(response_time, 0.95) AS "p95", PERCENTILE(response_time, 0.99) AS "p99", "app.name", "env.name" FROM "mulesoft.app.inbound" WHERE "sub_org.id" = '${orgId}' AND timestamp BETWEEN ${from} AND ${to} GROUP BY "app.name", "env.name"`;

            const data = await this.search(query, 500);
            return data.map((row) => ({
                appName: String(row['app.name'] || 'Unknown'),
                envName: String(row['env.name'] || 'Unknown'),
                requestCount: Number(row['request_count'] || 0),
                avgResponseTime: Number(row['avg_response_time'] || 0),
                p95: Number(row['p95'] || 0),
                p99: Number(row['p99'] || 0),
            }));
        });
    }

    /**
     * Build a full metrics export for a period
     */
    async exportMetrics(
        orgId: string,
        envId: string,
        envName: string,
        from: number,
        to: number,
    ): Promise<MetricsExport> {
        const apps = await this.getAppMetrics(orgId, envId, from, to);

        const totalRequests = apps.reduce((sum, m) => sum + m.requestCount, 0);
        const avgResponseTime =
            apps.length > 0
                ? apps.reduce((sum, m) => sum + m.avgResponseTime * m.requestCount, 0) / (totalRequests || 1)
                : 0;

        return {
            environment: envName,
            period: {
                from: new Date(from).toISOString(),
                to: new Date(to).toISOString(),
            },
            apps,
            summary: {
                totalRequests,
                avgResponseTime,
            },
        };
    }

    /**
     * Check if monitoring API is available
     */
    async isAvailable(): Promise<boolean> {
        try {
            await this.search('SELECT COUNT(requests) FROM "mulesoft.app.inbound" LIMIT 1');
            return true;
        } catch {
            return false;
        }
    }
}
