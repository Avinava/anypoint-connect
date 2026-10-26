/**
 * Log Analysis — Stats Calculator
 * Computes level distribution, error rate, spikes, and noise percentage.
 */

import type { EnrichedLogEntry, ErrorGroup, LogPattern, LogStats, ErrorSpike } from './types.js';
import { isNoise } from './normalize.js';

/** Logger key for entries whose line had no logger segment. */
export const UNKNOWN_LOGGER = '(none)';

/** Time bucket sizes accepted by `histogram`. */
export const BUCKETS = { '5m': 5 * 60 * 1000, '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000 } as const;
export type Bucket = keyof typeof BUCKETS;

export interface HistogramBucket {
    /** Bucket start, ISO 8601 UTC */
    start: string;
    total: number;
    byLevel: Record<string, number>;
}

/**
 * Count entries per time bucket, oldest first. Buckets are aligned to the clock
 * (a 15m bucket starts at :00, :15, :30 or :45) and empty buckets are omitted.
 */
export function histogram(entries: EnrichedLogEntry[], bucket: Bucket = '1h'): HistogramBucket[] {
    const size = BUCKETS[bucket];
    const buckets = new Map<number, HistogramBucket>();
    for (const entry of entries) {
        const start = Math.floor(entry.timestamp / size) * size;
        let row = buckets.get(start);
        if (!row) {
            row = { start: new Date(start).toISOString(), total: 0, byLevel: {} };
            buckets.set(start, row);
        }
        row.total++;
        row.byLevel[entry.priority] = (row.byLevel[entry.priority] || 0) + 1;
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

/** The `n` largest counts of a tally, largest first. */
export function topCounts(counts: Record<string, number>, n: number): Array<{ name: string; count: number }> {
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, n)
        .map(([name, count]) => ({ name, count }));
}

/**
 * Compute comprehensive statistics for a set of enriched entries.
 */
export function calculateStats(
    entries: EnrichedLogEntry[],
    totalLines: number,
    errorGroups?: ErrorGroup[],
    patterns?: LogPattern[],
): LogStats {
    const byLevel: Record<string, number> = {};
    const byLogger: Record<string, number> = {};
    let noiseCount = 0;
    const correlationIds = new Set<string>();
    const timestamps: number[] = [];

    for (const entry of entries) {
        byLevel[entry.priority] = (byLevel[entry.priority] || 0) + 1;
        const logger = entry.loggerName || UNKNOWN_LOGGER;
        byLogger[logger] = (byLogger[logger] || 0) + 1;
        if (isNoise(entry)) noiseCount++;
        if (entry.correlationId) correlationIds.add(entry.correlationId);
        if (entry.timestamp) timestamps.push(entry.timestamp);
    }

    timestamps.sort((a, b) => a - b);

    const errorCount = byLevel['ERROR'] || 0;
    const totalEntries = entries.length;
    const errorRate = totalEntries > 0 ? Math.round((errorCount / totalEntries) * 10000) / 100 : 0;
    const errorSpikes = calculateErrorSpikes(entries, 5 * 60 * 1000);

    return {
        totalLines,
        totalEntries,
        byLevel,
        byLogger,
        errorRate,
        timeRange: {
            start: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : '',
            end: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : '',
        },
        errorSpikes,
        topErrors: errorGroups || [],
        topPatterns: patterns || [],
        noisePercentage: totalEntries > 0 ? Math.round((noiseCount / totalEntries) * 10000) / 100 : 0,
        uniqueCorrelationIds: correlationIds.size,
    };
}

/**
 * Find 5-minute windows with above-average error rates.
 */
function calculateErrorSpikes(entries: EnrichedLogEntry[], windowMs: number): ErrorSpike[] {
    if (entries.length === 0) return [];

    const timestamps = entries.map((e) => e.timestamp).sort((a, b) => a - b);
    const start = timestamps[0];
    const end = timestamps[timestamps.length - 1];

    if (end - start < windowMs) return [];

    const windows = new Map<number, { total: number; errors: number }>();
    for (const entry of entries) {
        const windowStart = Math.floor((entry.timestamp - start) / windowMs) * windowMs + start;
        let w = windows.get(windowStart);
        if (!w) {
            w = { total: 0, errors: 0 };
            windows.set(windowStart, w);
        }
        w.total++;
        if (entry.priority === 'ERROR') w.errors++;
    }

    const totalErrors = entries.filter((e) => e.priority === 'ERROR').length;
    const avgErrorRate = entries.length > 0 ? totalErrors / entries.length : 0;

    const spikes: ErrorSpike[] = [];
    for (const [windowStart, w] of windows) {
        const rate = w.total > 0 ? w.errors / w.total : 0;
        if (rate > avgErrorRate * 1.5 && w.errors > 0) {
            spikes.push({
                window: new Date(windowStart).toISOString(),
                count: w.errors,
                rate: Math.round(rate * 10000) / 100,
            });
        }
    }

    return spikes.sort((a, b) => b.count - a.count).slice(0, 10);
}
