/**
 * Logs API
 * Log tailing, fetching, and downloading for CloudHub 2.0
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';
import type { CloudHub2Api } from './CloudHub2Api.js';

export interface LogEntry {
    loggerName?: string;
    threadName?: string;
    timestamp: number;
    message: string;
    priority: string;
    instanceId?: string;
    deploymentId?: string;
}

export interface LogSearchParams {
    appName?: string;
    deploymentId?: string;
    startTime?: number;
    endTime?: number;
    priority?: string;
    limit?: number;
    offset?: number;
    descending?: boolean;
    search?: string;
}

export interface LogSearchResponse {
    total: number;
    data: LogEntry[];
}

const AMC_BASE = '/amc/application-manager/api/v2';

export class LogsApi {
    constructor(
        private readonly http: HttpClient,
        private readonly _cache: Cache,
        private readonly ch2?: CloudHub2Api
    ) { }

    /**
     * Search logs via Anypoint Monitoring API (works for CH2)
     */
    async searchLogs(
        orgId: string,
        envId: string,
        deploymentId: string,
        params: LogSearchParams = {}
    ): Promise<LogSearchResponse> {
        const body: Record<string, unknown> = {
            deploymentId,
            limit: params.limit || 200,
            descending: params.descending ?? true,
        };

        if (params.startTime) body.startTime = params.startTime;
        if (params.endTime) body.endTime = params.endTime;
        if (params.priority) body.priority = params.priority;
        if (params.search) body.search = params.search;

        try {
            // Try Anypoint Monitoring API first
            const response = await this.http.post<LogSearchResponse>(
                `/monitoring/archive/api/v1/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}/logs`,
                body,
                {
                    headers: {
                        'X-ANYPNT-ORG-ID': orgId,
                        'X-ANYPNT-ENV-ID': envId,
                    },
                }
            );
            return response;
        } catch {
            // Fallback: try the Runtime Manager v2 logs endpoint
            try {
                const response = await this.http.post<LogSearchResponse>(
                    `${AMC_BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}/logs/search`,
                    body,
                    {
                        headers: {
                            'X-ANYPNT-ORG-ID': orgId,
                            'X-ANYPNT-ENV-ID': envId,
                        },
                    }
                );
                return response;
            } catch {
                return { total: 0, data: [] };
            }
        }
    }

    /**
     * Download log file for a CH2 deployment
     */
    async downloadLogFile(
        orgId: string,
        envId: string,
        deploymentId: string,
        specificationId: string
    ): Promise<Buffer> {
        return this.http.download(
            `${AMC_BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}/specs/${specificationId}/logs/file`,
            {
                headers: {
                    'X-ANYPNT-ORG-ID': orgId,
                    'X-ANYPNT-ENV-ID': envId,
                },
            }
        );
    }

    /**
     * Resolve app name to deployment ID using CH2 API
     */
    async resolveDeploymentId(orgId: string, envId: string, appName: string): Promise<string> {
        if (!this.ch2) {
            return appName; // fallback to using appName as deploymentId
        }

        const deployment = await this.ch2.findByName(orgId, envId, appName);
        if (!deployment) {
            throw new Error(`Application "${appName}" not found in environment`);
        }
        return deployment.id;
    }

    /**
     * Tail logs — generator that yields new log entries
     * Polls every `intervalMs` and yields entries newer than the cursor
     */
    async *tailLogs(
        orgId: string,
        envId: string,
        appName: string,
        options: {
            level?: string;
            intervalMs?: number;
            search?: string;
        } = {}
    ): AsyncGenerator<LogEntry[], void, unknown> {
        const intervalMs = options.intervalMs || 3000;
        const deploymentId = await this.resolveDeploymentId(orgId, envId, appName);
        let cursor = Date.now();
        const seenIds = new Set<string>();

        while (true) {
            try {
                const result = await this.searchLogs(orgId, envId, deploymentId, {
                    startTime: cursor,
                    priority: options.level,
                    search: options.search,
                    limit: 100,
                    descending: false,
                });

                if (result.data && result.data.length > 0) {
                    // Deduplicate
                    const newEntries = result.data.filter((entry) => {
                        const key = `${entry.timestamp}:${entry.message}`;
                        if (seenIds.has(key)) return false;
                        seenIds.add(key);
                        // Keep set from growing unbounded
                        if (seenIds.size > 5000) {
                            const arr = [...seenIds];
                            for (let i = 0; i < 2000; i++) seenIds.delete(arr[i]);
                        }
                        return true;
                    });

                    if (newEntries.length > 0) {
                        cursor = Math.max(...newEntries.map((e) => e.timestamp)) + 1;
                        yield newEntries;
                    }
                }
            } catch (err) {
                // On error, just wait and retry — don't break the tail
                console.error(`Log poll error: ${err instanceof Error ? err.message : err}`);
            }

            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }

    /**
     * Get all logs for a time range (handles pagination)
     */
    async getLogsForPeriod(
        orgId: string,
        envId: string,
        appName: string,
        startTime: number,
        endTime: number,
        level?: string
    ): Promise<LogEntry[]> {
        const deploymentId = await this.resolveDeploymentId(orgId, envId, appName);
        const allLogs: LogEntry[] = [];
        let offset = 0;
        const limit = 500;

        while (true) {
            const result = await this.searchLogs(orgId, envId, deploymentId, {
                startTime,
                endTime,
                priority: level,
                limit,
                offset,
                descending: false,
            });

            if (!result.data || result.data.length === 0) break;

            allLogs.push(...result.data);

            if (result.data.length < limit) break;
            offset += limit;

            // Safety: don't fetch more than 50k log lines
            if (allLogs.length >= 50000) break;
        }

        return allLogs;
    }
}
