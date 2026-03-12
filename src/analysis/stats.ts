/**
 * Log Analysis — Stats Calculator
 * Computes level distribution, error rate, spikes, and noise percentage.
 */

import type { EnrichedLogEntry, ErrorGroup, LogPattern, LogStats, ErrorSpike } from './types.js';
import { isNoise } from './utils.js';

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
    let noiseCount = 0;
    const correlationIds = new Set<string>();
    const timestamps: number[] = [];

    for (const entry of entries) {
        byLevel[entry.priority] = (byLevel[entry.priority] || 0) + 1;
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
