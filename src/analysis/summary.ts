/**
 * Log Analysis - Summary and line formatting
 * Compact views of a filtered set of entries, for responses that must stay small.
 */

import type { EnrichedLogEntry } from './types.js';
import { calculateStats, histogram, topCounts, type Bucket, type HistogramBucket } from './stats.js';
import { detectPatterns } from './pattern-detector.js';

/** Most histogram rows a summary returns; older buckets are dropped first. */
export const MAX_HISTOGRAM_ROWS = 500;

export interface LogSummary {
    totalEntries: number;
    timeRange: { start: string; end: string };
    byLevel: Record<string, number>;
    errorRate: number;
    /** Distinct logger names */
    loggerCount: number;
    byLogger: Array<{ name: string; count: number }>;
    histogram: { bucket: Bucket; rows: HistogramBucket[]; truncated?: { kept: number; total: number } };
    /** Most frequent message templates; HTTP listener DEBUG noise is left out */
    topTemplates: Array<{ template: string; level: string; count: number; percentage: number; logger?: string }>;
}

export interface SummaryOptions {
    bucket?: Bucket;
    topLoggers?: number;
    topTemplates?: number;
}

/** Counts by level, logger and time bucket, plus the top message templates. */
export function summarizeEntries(entries: EnrichedLogEntry[], options: SummaryOptions = {}): LogSummary {
    const bucket = options.bucket ?? '1h';
    const stats = calculateStats(entries, 0);
    const rows = histogram(entries, bucket);
    const kept = rows.slice(-MAX_HISTOGRAM_ROWS);

    return {
        totalEntries: stats.totalEntries,
        timeRange: stats.timeRange,
        byLevel: stats.byLevel,
        errorRate: stats.errorRate,
        loggerCount: Object.keys(stats.byLogger).length,
        byLogger: topCounts(stats.byLogger, options.topLoggers ?? 20),
        histogram: {
            bucket,
            rows: kept,
            ...(kept.length < rows.length ? { truncated: { kept: kept.length, total: rows.length } } : {}),
        },
        topTemplates: detectPatterns(entries, { topN: options.topTemplates ?? 15 }).map((p) => ({
            template: p.template,
            level: p.level,
            count: p.count,
            percentage: p.percentage,
            ...(p.loggerName ? { logger: p.loggerName } : {}),
        })),
    };
}

/** One entry as text: `<ISO ts> [LEVEL] <logger> - <message>`, followed by its stack trace lines. */
export function formatEntry(entry: EnrichedLogEntry): string {
    const ts = new Date(entry.timestamp).toISOString();
    const logger = entry.loggerName ? `${entry.loggerName} - ` : '';
    const head = `${ts} [${entry.priority}] ${logger}${entry.message ?? ''}`;
    return entry.stackTrace ? `${head}\n${entry.stackTrace}` : head;
}

/** Entries as log text, in the order given. */
export function formatEntries(entries: EnrichedLogEntry[]): string {
    return entries.map(formatEntry).join('\n');
}
