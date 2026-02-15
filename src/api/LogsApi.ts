/**
 * Logs API
 * Log tailing, fetching, and downloading for CloudHub 2.0
 * Uses the AMC log file download endpoint with spec ID resolution
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { CloudHub2Api, CH2Deployment } from './CloudHub2Api.js';
import { errorMessage } from '../utils/errors.js';

export interface LogEntry {
    timestamp: number;
    message: string;
    priority: string;
    loggerName?: string;
    threadName?: string;
    instanceId?: string;
    deploymentId?: string;
}

export interface LogSearchResponse {
    total: number;
    data: LogEntry[];
}

const AMC_BASE = '/amc/application-manager/api/v2';

/** Numeric priority for log level filtering */
const LEVEL_PRIORITY: Record<string, number> = {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    FATAL: 5,
};

export class LogsApi {
    constructor(
        private readonly http: HttpClient,
        private readonly ch2?: CloudHub2Api,
    ) {}

    /**
     * Download the full log file for a CH2 deployment.
     * Returns raw log text.
     */
    async downloadLogFile(orgId: string, envId: string, deploymentId: string, specId: string): Promise<Buffer> {
        return this.http.download(
            `${AMC_BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}/specs/${specId}/logs/file`,
            {
                headers: {
                    'X-ANYPNT-ORG-ID': orgId,
                    'X-ANYPNT-ENV-ID': envId,
                },
            },
        );
    }

    /**
     * Resolve an app name to its deployment + spec ID.
     */
    private async resolveDeployment(
        orgId: string,
        envId: string,
        appName: string,
    ): Promise<{ deploymentId: string; specId: string }> {
        if (!this.ch2) {
            throw new Error('CloudHub2Api required for log operations');
        }

        // Get full deployment detail to access desiredVersion (spec ID)
        const deployment = await this.ch2.findByName(orgId, envId, appName);
        if (!deployment) {
            throw new Error(`Application "${appName}" not found in environment`);
        }

        // Get detailed deployment info with desiredVersion
        const detail = await this.ch2.getDeployment(orgId, envId, deployment.id);
        const detailRecord = detail as unknown as Record<string, unknown>;
        const specId = (detailRecord.desiredVersion || detailRecord.lastSuccessfulVersion) as string | undefined;

        if (!specId) {
            throw new Error(`No spec version found for "${appName}" — app may not be fully deployed`);
        }

        return { deploymentId: deployment.id, specId };
    }

    /**
     * Parse a CH2 log line into structured LogEntry.
     * Format: "2026-02-13T22:42:32.359Z INFO [replicaId] message..."
     */
    private parseLogLine(line: string): LogEntry | null {
        if (!line.trim()) return null;

        // Match: timestamp LEVEL [instance] rest
        const match = line.match(
            /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\[([^\]]*)\]\s+(.*)$/,
        );

        if (match) {
            return {
                timestamp: new Date(match[1]).getTime(),
                priority: match[2],
                instanceId: match[3],
                message: match[4],
            };
        }

        // Continuation line (no timestamp prefix) — attach to last timestamp
        return {
            timestamp: Date.now(),
            priority: 'INFO',
            message: line,
        };
    }

    /**
     * Get parsed log entries for a CH2 application.
     * Fetches the log file and parses it.
     */
    async getLogs(
        orgId: string,
        envId: string,
        appName: string,
        options: {
            startTime?: number;
            endTime?: number;
            level?: string;
            limit?: number;
            search?: string;
        } = {},
    ): Promise<LogEntry[]> {
        const { deploymentId, specId } = await this.resolveDeployment(orgId, envId, appName);
        const buffer = await this.downloadLogFile(orgId, envId, deploymentId, specId);
        const text = buffer.toString('utf-8');
        const lines = text.split('\n');

        const minLevel = options.level ? (LEVEL_PRIORITY[options.level.toUpperCase()] ?? 0) : 0;

        let entries: LogEntry[] = [];
        for (const line of lines) {
            const entry = this.parseLogLine(line);
            if (!entry) continue;

            // Filter by time
            if (options.startTime && entry.timestamp < options.startTime) continue;
            if (options.endTime && entry.timestamp > options.endTime) continue;

            // Filter by level
            if ((LEVEL_PRIORITY[entry.priority] ?? 0) < minLevel) continue;

            // Filter by search
            if (options.search && !entry.message.toLowerCase().includes(options.search.toLowerCase())) continue;

            entries.push(entry);
        }

        // Sort descending by default (newest first), limit
        entries.sort((a, b) => b.timestamp - a.timestamp);
        if (options.limit) {
            entries = entries.slice(0, options.limit);
        }

        return entries;
    }

    /**
     * Tail logs — generator that yields new log entries.
     * Polls the log file periodically and yields new entries since last check.
     */
    async *tailLogs(
        orgId: string,
        envId: string,
        appName: string,
        options: {
            level?: string;
            intervalMs?: number;
            search?: string;
        } = {},
    ): AsyncGenerator<LogEntry[], void, unknown> {
        const intervalMs = options.intervalMs || 5000;
        const { deploymentId, specId } = await this.resolveDeployment(orgId, envId, appName);

        let lastTimestamp = Date.now() - 30000; // start from 30 seconds ago

        while (true) {
            try {
                const buffer = await this.downloadLogFile(orgId, envId, deploymentId, specId);
                const text = buffer.toString('utf-8');
                // Only parse the last portion for performance (last 100KB)
                const tail = text.length > 100000 ? text.substring(text.length - 100000) : text;
                const lines = tail.split('\n');

                const levelPriority = LEVEL_PRIORITY;
                const minLevel = options.level ? (levelPriority[options.level.toUpperCase()] ?? 0) : 0;

                const newEntries: LogEntry[] = [];
                for (const line of lines) {
                    const entry = this.parseLogLine(line);
                    if (!entry) continue;
                    if (entry.timestamp <= lastTimestamp) continue;
                    if ((levelPriority[entry.priority] ?? 0) < minLevel) continue;
                    if (options.search && !entry.message.toLowerCase().includes(options.search.toLowerCase())) continue;
                    newEntries.push(entry);
                }

                if (newEntries.length > 0) {
                    newEntries.sort((a, b) => a.timestamp - b.timestamp);
                    lastTimestamp = newEntries[newEntries.length - 1].timestamp;
                    yield newEntries;
                }
            } catch (err) {
                console.error(`Log poll error: ${errorMessage(err)}`);
            }

            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }

    /**
     * Get all logs for a time range.
     */
    async getLogsForPeriod(
        orgId: string,
        envId: string,
        appName: string,
        startTime: number,
        endTime: number,
        level?: string,
    ): Promise<LogEntry[]> {
        return this.getLogs(orgId, envId, appName, {
            startTime,
            endTime,
            level,
        });
    }
}
