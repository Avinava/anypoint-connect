/**
 * Log Analysis - Filter
 * One filter for every log surface: time window, minimum level, logger and text search.
 * Search covers the whole entry (logger, thread, message, stack trace and JSON payload),
 * so text on continuation lines is found on the entry it belongs to.
 */

import type { EnrichedLogEntry } from './types.js';
import { LEVEL_PRIORITY } from './normalize.js';

/** Hard cap on the lines a single search returns. */
export const MAX_LOG_LINES = 1000;

/** Longest regex pattern accepted for search. */
const MAX_PATTERN_LENGTH = 500;

export interface LogFilter {
    /** Inclusive start, epoch milliseconds */
    startTime?: number;
    /** Inclusive end, epoch milliseconds */
    endTime?: number;
    /** Minimum level: TRACE, DEBUG, INFO, WARN, ERROR or FATAL */
    level?: string;
    /** Case-insensitive substring of the logger name */
    logger?: string;
    /** Text to find anywhere in the entry */
    search?: string;
    /** Treat `search` as a case-insensitive regular expression */
    regex?: boolean;
}

export interface LogSearchOptions extends LogFilter {
    /** Most entries to return, newest first (default 100, capped at MAX_LOG_LINES) */
    limit?: number;
}

export interface LogSearchResult {
    /** Matches before `limit` was applied */
    total: number;
    /** Entries in this response */
    returned: number;
    truncated: boolean;
    /** Newest first */
    entries: EnrichedLogEntry[];
}

/** Validate a level name, returning its numeric priority. */
export function levelPriority(level: string): number {
    const name = level.toUpperCase();
    const priority = LEVEL_PRIORITY[name === 'WARNING' ? 'WARN' : name];
    if (priority === undefined) {
        throw new Error(`Unknown log level "${level}". Use one of ${Object.keys(LEVEL_PRIORITY).join(', ')}`);
    }
    return priority;
}

/** Build the text matcher for a search term, or null when there is none. */
export function buildMatcher(search?: string, regex?: boolean): ((text: string) => boolean) | null {
    if (!search) return null;
    if (regex) {
        if (search.length > MAX_PATTERN_LENGTH) {
            throw new Error(`Search regex is longer than ${MAX_PATTERN_LENGTH} characters`);
        }
        let pattern: RegExp;
        try {
            pattern = new RegExp(search, 'i');
        } catch (error) {
            throw new Error(`Invalid search regex: ${(error as Error).message}`);
        }
        return (text) => pattern.test(text);
    }
    const needle = search.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
}

/** The searchable text of an entry, in log line order. */
export function entryText(entry: EnrichedLogEntry): string {
    const header = [
        entry.loggerName,
        entry.eventId ? `event:${entry.eventId}` : undefined,
        entry.threadName !== undefined ? `${entry.threadName} -` : undefined,
        entry.message,
    ]
        .filter((part) => part !== undefined && part !== '')
        .join(' ');
    const parts = [header];
    if (entry.stackTrace) parts.push(entry.stackTrace);
    if (entry.jsonPayload) parts.push(JSON.stringify(entry.jsonPayload));
    return parts.join('\n');
}

/** Build a predicate for a filter. Validates the level and regex up front. */
export function buildFilter(filter: LogFilter): (entry: EnrichedLogEntry) => boolean {
    const minLevel = filter.level ? levelPriority(filter.level) : undefined;
    const logger = filter.logger?.toLowerCase();
    const matches = buildMatcher(filter.search, filter.regex);

    return (entry) => {
        if (filter.startTime !== undefined && entry.timestamp < filter.startTime) return false;
        if (filter.endTime !== undefined && entry.timestamp > filter.endTime) return false;
        if (minLevel !== undefined && (LEVEL_PRIORITY[entry.priority] ?? 0) < minLevel) return false;
        if (logger && !(entry.loggerName ?? '').toLowerCase().includes(logger)) return false;
        // The message alone first, so a regex anchored with ^ or $ means the message.
        if (matches && !matches(entry.message ?? '') && !matches(entryText(entry))) return false;
        return true;
    };
}

/** Keep the entries that pass a filter, in their original order. */
export function filterEntries(entries: EnrichedLogEntry[], filter: LogFilter): EnrichedLogEntry[] {
    const keep = buildFilter(filter);
    return entries.filter(keep);
}

/** Clamp a requested line count to 1..MAX_LOG_LINES. */
export function clampLimit(limit: number | undefined, fallback = 100): number {
    const value = limit === undefined || !Number.isFinite(limit) ? fallback : Math.floor(limit);
    return Math.min(Math.max(value, 1), MAX_LOG_LINES);
}

/**
 * Filter entries and return the newest `limit` matches.
 * `total` counts every match, so callers can tell when the result was cut.
 */
export function searchEntries(entries: EnrichedLogEntry[], options: LogSearchOptions = {}): LogSearchResult {
    const limit = clampLimit(options.limit);
    const matched = filterEntries(entries, options);
    // Reverse, then a stable sort: entries that share a timestamp stay newest first.
    const newestFirst = [...matched].reverse().sort((a, b) => b.timestamp - a.timestamp);
    const page = newestFirst.slice(0, limit);
    return { total: matched.length, returned: page.length, truncated: matched.length > page.length, entries: page };
}
