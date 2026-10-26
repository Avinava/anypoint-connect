/**
 * Logs API
 * Log tailing, fetching, and downloading for CloudHub 2.0
 * Uses the AMC log file download endpoint with spec ID resolution
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { CloudHub2Api } from './CloudHub2Api.js';
import type { EnrichedLogEntry } from '../analysis/types.js';
import { parseRawLogs } from '../analysis/parser.js';
import { buildFilter, searchEntries, type LogFilter, type LogSearchOptions } from '../analysis/filter.js';
import { errorMessage } from '../utils/errors.js';

export { MAX_LOG_LINES } from '../analysis/filter.js';
export type { LogFilter, LogSearchOptions } from '../analysis/filter.js';

export interface LogEntry {
    timestamp: number;
    message: string;
    priority: string;
    loggerName?: string;
    threadName?: string;
    instanceId?: string;
    deploymentId?: string;
}

/** Where a log file came from. */
export interface LogSource {
    deploymentId: string;
    /** The spec whose log file was read */
    specId: string;
    /** Set when the desired spec had no log file or an empty one, and the last successful spec was read instead */
    fallbackFromSpecId?: string;
}

export interface LogFile extends LogSource {
    text: string;
}

export interface LogSearchResponse {
    /** Matches before `limit` was applied */
    total: number;
    /** Entries returned */
    returned: number;
    truncated: boolean;
    /** Newest first */
    entries: EnrichedLogEntry[];
    source: LogSource;
}

const AMC_BASE = '/amc/application-manager/api/v2';

function httpStatus(error: unknown): number | undefined {
    return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

function sourceOf(file: LogFile): LogSource {
    const source: LogSource = { deploymentId: file.deploymentId, specId: file.specId };
    if (file.fallbackFromSpecId) source.fallbackFromSpecId = file.fallbackFromSpecId;
    return source;
}

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
     * Resolve an app name to its deployment and the specs whose logs to read, preferred first:
     * the desired spec, then the last successful one when it differs.
     */
    private async resolveDeployment(
        orgId: string,
        envId: string,
        appName: string,
    ): Promise<{ deploymentId: string; specIds: string[] }> {
        if (!this.ch2) {
            throw new Error('CloudHub2Api required for log operations');
        }

        const deployment = await this.ch2.findByName(orgId, envId, appName);
        if (!deployment) {
            throw new Error(`Application "${appName}" not found in environment`);
        }

        const detail = await this.ch2.getDeployment(orgId, envId, deployment.id);
        const specIds = [detail.desiredVersion, detail.lastSuccessfulVersion].filter(
            (id, i, all): id is string => !!id && all.indexOf(id) === i,
        );

        if (specIds.length === 0) {
            throw new Error(`No spec version found for "${appName}". The app may not be fully deployed yet`);
        }

        return { deploymentId: deployment.id, specIds };
    }

    /**
     * Fetch the log file for an app. Reads the desired spec's file; right after a change that
     * file can be missing or empty while the platform starts the new replicas, so the last
     * successful spec's file is read instead and `fallbackFromSpecId` says so.
     */
    async getLogFile(orgId: string, envId: string, appName: string): Promise<LogFile> {
        const { deploymentId, specIds } = await this.resolveDeployment(orgId, envId, appName);
        const [desired, previous] = specIds;

        let text = '';
        try {
            text = (await this.downloadLogFile(orgId, envId, deploymentId, desired)).toString('utf-8');
        } catch (error) {
            if (!previous || httpStatus(error) !== 404) throw error;
        }
        if (text.trim() || !previous) {
            return { deploymentId, specId: desired, text };
        }

        const fallback = (await this.downloadLogFile(orgId, envId, deploymentId, previous)).toString('utf-8');
        return { deploymentId, specId: previous, fallbackFromSpecId: desired, text: fallback };
    }

    /**
     * Get raw log text for a CH2 application (for analysis pipeline).
     * Returns the full log file as a string without parsing.
     */
    async getRawText(orgId: string, envId: string, appName: string): Promise<string> {
        return (await this.getLogFile(orgId, envId, appName)).text;
    }

    /**
     * Search an app's log file. Multi-line entries (stack traces, error reports, JSON Logger
     * bodies) are joined to the line that starts them and keep its timestamp and level.
     * Returns the newest `limit` matches (default 100, at most MAX_LOG_LINES) and the full match count.
     */
    async searchLogs(
        orgId: string,
        envId: string,
        appName: string,
        options: LogSearchOptions = {},
    ): Promise<LogSearchResponse> {
        const file = await this.getLogFile(orgId, envId, appName);
        return { ...searchEntries(parseRawLogs(file.text), options), source: sourceOf(file) };
    }

    /**
     * Get parsed log entries for a CH2 application, newest first.
     * See `searchLogs` for the counts and the source spec.
     */
    async getLogs(
        orgId: string,
        envId: string,
        appName: string,
        options: LogSearchOptions = {},
    ): Promise<EnrichedLogEntry[]> {
        return (await this.searchLogs(orgId, envId, appName, options)).entries;
    }

    /**
     * Every entry that passes a filter, oldest first, with no line cap.
     */
    async queryLogs(
        orgId: string,
        envId: string,
        appName: string,
        filter: LogFilter = {},
    ): Promise<{ entries: EnrichedLogEntry[]; source: LogSource }> {
        const file = await this.getLogFile(orgId, envId, appName);
        return { entries: parseRawLogs(file.text).filter(buildFilter(filter)), source: sourceOf(file) };
    }

    /**
     * Tail logs: a generator that yields new log entries.
     * Polls the log file and re-resolves the spec each time, so a restart is followed.
     */
    async *tailLogs(
        orgId: string,
        envId: string,
        appName: string,
        options: {
            level?: string;
            intervalMs?: number;
            search?: string;
            regex?: boolean;
            logger?: string;
        } = {},
    ): AsyncGenerator<LogEntry[], void, unknown> {
        const intervalMs = options.intervalMs || 5000;
        const keep = buildFilter({
            level: options.level,
            search: options.search,
            regex: options.regex,
            logger: options.logger,
        });

        let lastTimestamp = Date.now() - 30000; // start from 30 seconds ago

        while (true) {
            try {
                const { text } = await this.getLogFile(orgId, envId, appName);
                // Only parse the last portion for performance (last 100KB)
                const tail = text.length > 100000 ? text.substring(text.length - 100000) : text;

                const newEntries = parseRawLogs(tail).filter((e) => e.timestamp > lastTimestamp && keep(e));

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
     * Get all logs for a time range, newest first.
     */
    async getLogsForPeriod(
        orgId: string,
        envId: string,
        appName: string,
        startTime: number,
        endTime: number,
        level?: string,
    ): Promise<EnrichedLogEntry[]> {
        const { entries } = await this.queryLogs(orgId, envId, appName, { startTime, endTime, level });
        return entries.reverse();
    }
}
