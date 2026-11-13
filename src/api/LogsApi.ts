/**
 * Logs API
 * Log tailing, fetching, and downloading for CloudHub 2.0
 * Uses the AMC log file download endpoint with spec ID resolution
 */

import { setTimeout as delay } from 'node:timers/promises';
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
    /** Cancels the request in flight. */
    signal?: AbortSignal;
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

/** One spec's log text. */
export interface LogPart {
    specId: string;
    text: string;
}

/** The log text of every spec read, kept apart, oldest first. */
export interface LogParts extends LogSource {
    parts: LogPart[];
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

/** What a followed log reports. */
export type TailEvent =
    /** New records, oldest first, that pass the filters. */
    | { type: 'records'; entries: EnrichedLogEntry[]; specId: string }
    /** The spec being followed: first announced, then whenever it changes. */
    | { type: 'specChange'; from: string | null; to: string; fallbackFromSpecId?: string }
    /** Records may have been missed: more arrived between reads than one read covers. */
    | { type: 'gap'; message: string }
    /** A read failed; following continues. */
    | { type: 'error'; message: string }
    /** How the log is read: `incremental` asks only for records after the last one seen; `file` downloads the whole file each time (the incremental endpoint was unavailable). */
    | { type: 'transport'; mode: 'incremental' | 'file'; reason?: string };

/** A record from the structured log endpoint. */
interface StructuredRecord {
    docId: string | number;
    timestamp: number;
    message?: string | null;
    replicaId?: string;
    logLevel?: string;
    context?: { logger?: string; class?: string; event?: string };
}

interface TailItem {
    entry: EnrichedLogEntry;
    /** Identity at its own millisecond: the platform's docId, or the line's content for a file read. */
    key: string;
}

interface TailRead {
    mode: 'incremental' | 'file';
    specId: string;
    fallbackFromSpecId?: string;
    items: TailItem[];
    /** More records are waiting than one read fetched. */
    backlog: boolean;
    gap?: string;
    /** Set when a whole page shared this millisecond, so the gap is certain; otherwise a gap is reported only when the read does not reach back to the last record seen. */
    tiedAt?: number;
}

/** The incremental endpoint cannot serve this read; the full file is read instead. */
class IncrementalUnavailableError extends Error {}

function structuredEntry(row: StructuredRecord): EnrichedLogEntry {
    return {
        timestamp: row.timestamp,
        message: row.message ?? '',
        priority: row.logLevel ?? 'INFO',
        ...(row.replicaId ? { instanceId: row.replicaId } : {}),
        ...(row.context?.logger || row.context?.class ? { loggerName: row.context.logger ?? row.context.class } : {}),
        ...(row.context?.event ? { eventId: row.context.event } : {}),
    };
}

/** The endpoint returns 10 records per request whatever `limit` says. */
const INCREMENTAL_PAGE_SIZE = 10;
/** Requests per read; a larger backlog is read again at once rather than in one long call. */
const MAX_INCREMENTAL_PAGES = 50;
/** Added to now for the range end, so a clock slightly behind the platform's does not hide the newest records. */
const INCREMENTAL_END_SKEW_MS = 5 * 60_000;
/** How far behind the log the tail may fall while draining a backlog before it skips ahead. */
const MAX_TAIL_LAG_MS = 120_000;

export interface TailOptions extends Pick<LogFilter, 'level' | 'search' | 'regex' | 'logger'> {
    /** Milliseconds between reads (default 5000). */
    intervalMs?: number;
    /** Follow exactly this spec instead of the current one. */
    specId?: string;
    /** Stops following, including the wait and the request in flight. */
    signal?: AbortSignal;
}

/** Characters of the log file one read looks at, from the end. Larger files are read in full but only this tail is parsed. */
const TAIL_WINDOW_CHARS = 500_000;

/** A record's identity at its own millisecond: everything that distinguishes two lines the platform wrote. */
function tailKey(entry: LogEntry): string {
    return [entry.priority, entry.instanceId ?? '', entry.threadName ?? '', entry.loggerName ?? '', entry.message].join(
        '\u0000',
    );
}

function bump(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
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
    async downloadLogFile(
        orgId: string,
        envId: string,
        deploymentId: string,
        specId: string,
        signal?: AbortSignal,
    ): Promise<Buffer> {
        return this.http.download(
            `${AMC_BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}/specs/${specId}/logs/file`,
            {
                headers: {
                    'X-ANYPNT-ORG-ID': orgId,
                    'X-ANYPNT-ENV-ID': envId,
                },
                ...(signal ? { signal } : {}),
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
        const { parts, ...source } = await this.getLogParts(orgId, envId, appName, read);
        if (!source.specIds) return { ...source, text: parts[0]?.text ?? '' };
        const blocks = parts.filter((p) => p.text.trim()).map((p) => (p.text.endsWith('\n') ? p.text : `${p.text}\n`));
        return { ...source, text: blocks.join('') };
    }

    /**
     * The same read as {@link getLogFile}, with each spec's text kept apart, for callers that
     * report per spec. With previousSpecs, specs without a log file (never started, or expired)
     * are skipped.
     */
    async getLogParts(orgId: string, envId: string, appName: string, read: LogReadOptions = {}): Promise<LogParts> {
        const previousSpecs = checkPreviousSpecs(read.previousSpecs ?? 0);
        const { deploymentId, specIds } = await this.resolveDeployment(orgId, envId, appName);
        const [desired, previous] = specIds;
        if (previousSpecs > 0) {
            return this.readSpecs(orgId, envId, deploymentId, desired, previousSpecs);
        }

        let text = '';
        try {
            text = (await this.downloadLogFile(orgId, envId, deploymentId, desired, read.signal)).toString('utf-8');
        } catch (error) {
            if (!previous || httpStatus(error) !== 404) throw error;
        }
        if (text.trim() || !previous) {
            return { deploymentId, specId: desired, parts: [{ specId: desired, text }] };
        }

        const fallback = (await this.downloadLogFile(orgId, envId, deploymentId, previous, read.signal)).toString(
            'utf-8',
        );
        return {
            deploymentId,
            specId: previous,
            fallbackFromSpecId: desired,
            parts: [{ specId: previous, text: fallback }],
        };
    }

    /** Read the desired spec and up to `count` specs before it, oldest first. */
    private async readSpecs(
        orgId: string,
        envId: string,
        deploymentId: string,
        desired: string,
        count: number,
    ): Promise<LogParts> {
        if (!this.ch2) throw new Error('CloudHub2Api required for log operations');
        // The specs API lists newest first; start at the desired spec so a newer, unapplied one is not read.
        const all = (await this.ch2.getDeploymentSpecs(orgId, envId, deploymentId)).map((s) => s.version);
        const start = Math.max(all.indexOf(desired), 0);
        const chosen = [desired, ...all.slice(start).filter((id) => id !== desired)].slice(0, count + 1).reverse();

        const parts: LogPart[] = [];
        for (const specId of chosen) {
            try {
                const text = (await this.downloadLogFile(orgId, envId, deploymentId, specId)).toString('utf-8');
                parts.push({ specId, text });
            } catch (error) {
                if (httpStatus(error) !== 404) throw error;
            }
        }
        return { deploymentId, specId: desired, specIds: parts.map((p) => p.specId), parts };
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
     * Follow an app's log as typed events. Polls the log file; each poll yields only records not
     * yielded before. Records that share a millisecond are all kept (and identical lines counted),
     * the position advances past every record read before any filter hides some, and `signal`
     * stops the wait and the request in flight.
     *
     * Without `specId` it follows the current spec (the desired one, or the last successful one
     * with a notice) and says when that changes. With `specId` it follows exactly that spec: one
     * that is not this app's is an error, never replaced by another; so is one with no log file when the
     * log is read from the file. On the incremental endpoint a spec without records yet is simply
     * followed until it has some.
     */
    async *tailEvents(
        orgId: string,
        envId: string,
        appName: string,
        options: TailOptions = {},
    ): AsyncGenerator<TailEvent, void, undefined> {
        const { signal, specId: pinnedSpec } = options;
        const intervalMs = options.intervalMs || 5000;
        const keep = buildFilter({
            level: options.level,
            search: options.search,
            regex: options.regex,
            logger: options.logger,
        });
        const pinned = pinnedSpec ? await this.resolvePinnedSpec(orgId, envId, appName, pinnedSpec) : undefined;

        let followed: string | null = null;
        let lastTs = Date.now() - 30_000; // start from 30 seconds ago
        let atLast = new Map<string, number>(); // records already yielded at exactly lastTs
        let polled = false;
        let mode: 'incremental' | 'file' | null = null;
        let incrementalUnsupported = false;
        let reportedTieAt: number | undefined;

        while (!signal?.aborted) {
            let drainNext = false; // a backlog is waiting: read again without sleeping
            try {
                let read: TailRead | undefined;
                if (!incrementalUnsupported) {
                    try {
                        read = pinned
                            ? await this.readStructured(
                                  orgId,
                                  envId,
                                  pinned.deploymentId,
                                  pinned.specId,
                                  lastTs,
                                  signal,
                              )
                            : await this.readStructuredCurrent(orgId, envId, appName, followed, lastTs, signal);
                    } catch (error) {
                        if (!(error instanceof IncrementalUnavailableError)) throw error;
                        incrementalUnsupported = true;
                        yield { type: 'transport', mode: 'file', reason: error.message };
                        mode = 'file';
                    }
                }
                if (!read) read = await this.readFileWindow(orgId, envId, appName, pinned, signal);
                if (read.mode === 'incremental' && mode !== 'incremental') {
                    yield { type: 'transport', mode: 'incremental' };
                    mode = 'incremental';
                }

                if (read.specId !== followed) {
                    yield {
                        type: 'specChange',
                        from: followed,
                        to: read.specId,
                        ...(read.fallbackFromSpecId ? { fallbackFromSpecId: read.fallbackFromSpecId } : {}),
                    };
                    if (followed !== null) atLast = new Map(); // a new file: nothing of it was seen
                    followed = read.specId;
                }
                if (read.gap) {
                    if (read.tiedAt !== undefined) {
                        // Certain, and the same tie shows up on every later read: say it once per millisecond.
                        if (read.tiedAt !== reportedTieAt) {
                            reportedTieAt = read.tiedAt;
                            yield { type: 'gap', message: read.gap };
                        }
                    } else if (polled && read.items.length > 0 && read.items[0].entry.timestamp > lastTs) {
                        yield { type: 'gap', message: read.gap };
                    }
                }
                polled = true;
                drainNext = false;

                const fresh: TailItem[] = [];
                const seenNow = new Map<string, number>();
                for (const item of read.items) {
                    if (item.entry.timestamp < lastTs) continue;
                    if (item.entry.timestamp === lastTs) {
                        const n = (seenNow.get(item.key) ?? 0) + 1;
                        seenNow.set(item.key, n);
                        if (n <= (atLast.get(item.key) ?? 0)) continue;
                    }
                    fresh.push(item);
                }
                // Read again at once only while reads keep producing something new; an empty read waits like any other.
                drainNext = read.backlog && fresh.length > 0;
                if (fresh.length > 0) {
                    const newest = fresh[fresh.length - 1].entry.timestamp;
                    if (newest === lastTs) {
                        for (const item of fresh) bump(atLast, item.key);
                    } else {
                        lastTs = newest;
                        atLast = new Map();
                        for (const item of fresh) if (item.entry.timestamp === newest) bump(atLast, item.key);
                    }
                    const shown = fresh.map((i) => i.entry).filter(keep);
                    if (shown.length > 0) yield { type: 'records', entries: shown, specId: read.specId };
                }
                if (drainNext && lastTs < Date.now() - MAX_TAIL_LAG_MS) {
                    // The app writes faster than the endpoint can be read: say so and catch up instead of falling further behind.
                    yield {
                        type: 'gap',
                        message: `The tail fell more than ${MAX_TAIL_LAG_MS / 1000} seconds behind the log and skipped ahead to the last 30 seconds; the lines in between were not shown. Read them with \`anc logs search\`.`,
                    };
                    lastTs = Date.now() - 30_000;
                    atLast = new Map();
                }
            } catch (error) {
                if (signal?.aborted) return;
                // A pinned spec must be readable at least once; after that a failed read is reported and retried.
                if (pinned && !polled) throw error;
                yield { type: 'error', message: errorMessage(error) };
            }

            if (drainNext) continue;
            try {
                await delay(intervalMs, undefined, { signal });
            } catch {
                return; // cancelled
            }
        }
    }

    /**
     * Tail logs: a generator that yields new log entries. A view of {@link tailEvents} for callers
     * that want only the records; read errors go to stderr and following continues.
     */
    async *tailLogs(
        orgId: string,
        envId: string,
        appName: string,
        options: Omit<TailOptions, 'signal' | 'specId'> = {},
    ): AsyncGenerator<LogEntry[], void, unknown> {
        for await (const event of this.tailEvents(orgId, envId, appName, options)) {
            if (event.type === 'records') yield event.entries;
            else if (event.type === 'error') console.error(`Log poll error: ${event.message}`);
        }
    }

    /**
     * The incremental read: records of one spec from `since` on, through the structured log endpoint.
     * It returns 10 records per request, oldest first, with `startTime` inclusive, so the read walks
     * forward by the last record's time and drops repeats by `docId`. At most MAX_INCREMENTAL_PAGES
     * requests per read; when more remain the read says so and the caller reads again at once.
     */
    private async readStructured(
        orgId: string,
        envId: string,
        deploymentId: string,
        specId: string,
        since: number,
        signal?: AbortSignal,
    ): Promise<TailRead> {
        const items: TailItem[] = [];
        const seen = new Set<string>();
        let start = since;
        let backlog = false;
        let tiedAt: number | undefined;
        for (let page = 0; ; page++) {
            const rows = await this.fetchStructuredPage(
                orgId,
                envId,
                deploymentId,
                specId,
                start,
                Date.now() + INCREMENTAL_END_SKEW_MS,
                signal,
            );
            for (const row of rows) {
                const key = String(row.docId);
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({ entry: structuredEntry(row), key });
            }
            if (rows.length < INCREMENTAL_PAGE_SIZE) break; // the last page
            const lastTs = rows[rows.length - 1].timestamp;
            if (lastTs === start) {
                // A whole page at one millisecond: the endpoint cannot page inside it, so step past it.
                tiedAt = lastTs;
                start = lastTs + 1;
            } else {
                start = lastTs;
            }
            if (page + 1 >= MAX_INCREMENTAL_PAGES) {
                backlog = true;
                break;
            }
        }
        return {
            mode: 'incremental',
            specId,
            items,
            backlog,
            ...(tiedAt !== undefined
                ? {
                      gap: `More than ${INCREMENTAL_PAGE_SIZE} records share one millisecond and the platform cannot page inside it, so some may be missing.`,
                      tiedAt,
                  }
                : {}),
        };
    }

    /** The incremental read of the current spec: the desired one, or the last successful one while the desired has no records. */
    private async readStructuredCurrent(
        orgId: string,
        envId: string,
        appName: string,
        followed: string | null,
        since: number,
        signal?: AbortSignal,
    ): Promise<TailRead> {
        const { deploymentId, specIds } = await this.resolveDeployment(orgId, envId, appName);
        const [desired, previous] = specIds;
        const read = await this.readStructured(orgId, envId, deploymentId, desired, since, signal);
        if (read.items.length > 0 || !previous || followed === desired) return read;
        const fallback = await this.readStructured(orgId, envId, deploymentId, previous, since, signal);
        // Keep following the fallback while the desired spec is still silent; the first poll settles on desired if both are.
        if (fallback.items.length > 0 || followed === previous) return { ...fallback, fallbackFromSpecId: desired };
        return read;
    }

    private async fetchStructuredPage(
        orgId: string,
        envId: string,
        deploymentId: string,
        specId: string,
        startTime: number,
        endTime: number,
        signal?: AbortSignal,
    ): Promise<StructuredRecord[]> {
        let data: unknown;
        try {
            data = await this.http.get<unknown>(
                `${AMC_BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}/specs/${specId}/logs`,
                {
                    headers: { 'X-ANYPNT-ORG-ID': orgId, 'X-ANYPNT-ENV-ID': envId },
                    // Epoch milliseconds: ISO timestamps are rejected.
                    params: { startTime, endTime, descending: false },
                    ...(signal ? { signal } : {}),
                },
            );
        } catch (error) {
            const status = httpStatus(error);
            // A spec without logs can answer 404 (as its log file does): that is no records, not a missing endpoint.
            if (status === 404) return [];
            // The endpoint rejects the request or does not exist for this API: use the file instead.
            if (status === 400 || status === 405 || status === 501) {
                throw new IncrementalUnavailableError(`the incremental log endpoint answered HTTP ${status}`);
            }
            throw error;
        }
        const valid =
            Array.isArray(data) &&
            data.every(
                (r) =>
                    r &&
                    typeof r === 'object' &&
                    (typeof r.docId === 'string' || typeof r.docId === 'number') &&
                    typeof r.timestamp === 'number',
            );
        if (!valid) throw new IncrementalUnavailableError('the incremental log endpoint returned an unexpected shape');
        return data as StructuredRecord[];
    }

    /** The full-file read: download the log file and parse its newest window. */
    private async readFileWindow(
        orgId: string,
        envId: string,
        appName: string,
        pinned: { deploymentId: string; specId: string } | undefined,
        signal?: AbortSignal,
    ): Promise<TailRead> {
        const read = pinned
            ? await this.readPinnedSpec(orgId, envId, pinned.deploymentId, pinned.specId, signal)
            : await this.readCurrentSpec(orgId, envId, appName, signal);
        const cut = read.text.length > TAIL_WINDOW_CHARS;
        const window = cut
            ? read.text.slice(read.text.indexOf('\n', read.text.length - TAIL_WINDOW_CHARS) + 1)
            : read.text;
        // Stable sort: records that share a timestamp keep their file order.
        const entries = parseRawLogs(window).sort((a, b) => a.timestamp - b.timestamp);
        return {
            mode: 'file',
            specId: read.specId,
            ...(read.fallbackFromSpecId ? { fallbackFromSpecId: read.fallbackFromSpecId } : {}),
            items: entries.map((entry) => ({ entry, key: tailKey(entry) })),
            backlog: false,
            ...(cut
                ? {
                      gap: 'Some log lines were missed: more arrived between reads than one read covers. Read the full log with `anc logs search` to see them.',
                  }
                : {}),
        };
    }

    /** The deployment of `appName` and `specId`, once the spec is known to belong to it. */
    private async resolvePinnedSpec(
        orgId: string,
        envId: string,
        appName: string,
        specId: string,
    ): Promise<{ deploymentId: string; specId: string }> {
        const { deploymentId } = await this.resolveDeployment(orgId, envId, appName);
        const known = (await this.ch2!.getDeploymentSpecs(orgId, envId, deploymentId)).map((s) => s.version);
        if (!known.includes(specId)) {
            throw new Error(
                `Spec "${specId}" does not belong to "${appName}". Its specs, newest first: ${known.slice(0, MAX_PREVIOUS_SPECS + 1).join(', ') || 'none'}`,
            );
        }
        return { deploymentId, specId };
    }

    private async readPinnedSpec(
        orgId: string,
        envId: string,
        deploymentId: string,
        specId: string,
        signal?: AbortSignal,
    ) {
        try {
            const text = (await this.downloadLogFile(orgId, envId, deploymentId, specId, signal)).toString('utf-8');
            return { specId, text, fallbackFromSpecId: undefined };
        } catch (error) {
            if (httpStatus(error) === 404) {
                throw new Error(
                    `Spec "${specId}" has no log file (it never started, or the log expired). No other spec was read.`,
                );
            }
            throw error;
        }
    }

    private async readCurrentSpec(orgId: string, envId: string, appName: string, signal?: AbortSignal) {
        const { specId, fallbackFromSpecId, parts } = await this.getLogParts(orgId, envId, appName, { signal });
        return { specId, fallbackFromSpecId, text: parts[0]?.text ?? '' };
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
