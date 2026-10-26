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

/** Most earlier specs one read may include. */
export const MAX_PREVIOUS_SPECS = 10;

export interface LogReadOptions {
    /**
     * Also read this many specs before the desired one (0 to MAX_PREVIOUS_SPECS), so the generation
     * replaced by an update stays visible. Default 0: the desired spec, or the last successful one.
     */
    previousSpecs?: number;
}

/** Where a log file came from. */
export interface LogSource {
    deploymentId: string;
    /** The spec whose log file was read */
    specId: string;
    /** Set when the desired spec had no log file or an empty one, and the last successful spec was read instead */
    fallbackFromSpecId?: string;
    /** With previousSpecs: every spec whose log file was read, oldest first */
    specIds?: string[];
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
    const { text: _text, ...source } = file;
    return source;
}

/**
 * Parse a log file into entries, oldest first. A file read across several specs holds one
 * block per spec, and replicas of two generations can overlap in time, so entries are sorted.
 */
export function parseLogFile(file: LogFile): EnrichedLogEntry[] {
    const entries = parseRawLogs(file.text);
    // Stable sort: entries that share a timestamp keep their file order.
    return (file.specIds?.length ?? 0) > 1 ? entries.sort((a, b) => a.timestamp - b.timestamp) : entries;
}

function checkPreviousSpecs(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > MAX_PREVIOUS_SPECS) {
        throw new Error(`previousSpecs must be a whole number from 0 to ${MAX_PREVIOUS_SPECS}`);
    }
    return count;
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
    async getLogFile(orgId: string, envId: string, appName: string, read: LogReadOptions = {}): Promise<LogFile> {
        const previousSpecs = checkPreviousSpecs(read.previousSpecs ?? 0);
        const { deploymentId, specIds } = await this.resolveDeployment(orgId, envId, appName);
        const [desired, previous] = specIds;
        if (previousSpecs > 0) {
            return this.readSpecs(orgId, envId, deploymentId, desired, previousSpecs);
        }

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
     * Read the desired spec and up to `count` specs before it, joined oldest first.
     * Specs without a log file (never started, or expired) are skipped.
     */
    private async readSpecs(
        orgId: string,
        envId: string,
        deploymentId: string,
        desired: string,
        count: number,
    ): Promise<LogFile> {
        if (!this.ch2) throw new Error('CloudHub2Api required for log operations');
        // The specs API lists newest first; start at the desired spec so a newer, unapplied one is not read.
        const all = (await this.ch2.getDeploymentSpecs(orgId, envId, deploymentId)).map((s) => s.version);
        const start = Math.max(all.indexOf(desired), 0);
        const chosen = [desired, ...all.slice(start).filter((id) => id !== desired)].slice(0, count + 1).reverse();

        const read: string[] = [];
        const blocks: string[] = [];
        for (const specId of chosen) {
            try {
                const text = (await this.downloadLogFile(orgId, envId, deploymentId, specId)).toString('utf-8');
                read.push(specId);
                if (text.trim()) blocks.push(text.endsWith('\n') ? text : `${text}\n`);
            } catch (error) {
                if (httpStatus(error) !== 404) throw error;
            }
        }
        return { deploymentId, specId: desired, specIds: read, text: blocks.join('') };
    }

    /**
     * Get raw log text for a CH2 application (for analysis pipeline).
     * Returns the full log file as a string without parsing.
     */
    async getRawText(orgId: string, envId: string, appName: string, read: LogReadOptions = {}): Promise<string> {
        return (await this.getLogFile(orgId, envId, appName, read)).text;
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
        options: LogSearchOptions & LogReadOptions = {},
    ): Promise<LogSearchResponse> {
        const file = await this.getLogFile(orgId, envId, appName, options);
        return { ...searchEntries(parseLogFile(file), options), source: sourceOf(file) };
    }

    /**
     * Get parsed log entries for a CH2 application, newest first.
     * See `searchLogs` for the counts and the source spec.
     */
    async getLogs(
        orgId: string,
        envId: string,
        appName: string,
        options: LogSearchOptions & LogReadOptions = {},
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
        read: LogReadOptions = {},
    ): Promise<{ entries: EnrichedLogEntry[]; source: LogSource }> {
        const file = await this.getLogFile(orgId, envId, appName, read);
        return { entries: parseLogFile(file).filter(buildFilter(filter)), source: sourceOf(file) };
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
