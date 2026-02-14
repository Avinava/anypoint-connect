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
    errorCount: number;
    errorRate: number;
    outboundCount: number;
    outboundAvgResponseTime: number;
}

export interface MetricsExport {
    environment: string;
    period: { from: string; to: string };
    apps: AppMetricsSummary[];
    summary: {
        totalRequests: number;
        avgResponseTime: number;
        totalErrors: number;
        errorRate: number;
    };
}

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
     * Get inbound metrics for a time range
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
                errorCount: 0,
                errorRate: 0,
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
                    errorCount: 0,
                    errorRate: 0,
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
        const totalErrors = apps.reduce((sum, m) => sum + m.errorCount, 0);
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
                totalErrors,
                errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
            },
        };
    }

    /**
     * Check if monitoring API is available
     */
    async isAvailable(): Promise<boolean> {
        try {
            const data = await this.search('SELECT COUNT(requests) FROM "mulesoft.app.inbound" LIMIT 1');
            return data.length >= 0; // Even empty result means API is accessible
        } catch {
            return false;
        }
    }
}
