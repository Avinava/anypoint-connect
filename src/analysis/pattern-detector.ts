/**
 * Log Analysis — Pattern Detector
 * Identifies the top N recurring log message templates.
 */

import type { EnrichedLogEntry, LogPattern } from './types.js';
import { templatize, isNoise } from './utils.js';

export interface PatternDetectorOptions {
    /** Number of top patterns to return (default: 15) */
    topN?: number;
    /** Whether to exclude HTTP listener noise (default: true) */
    excludeNoise?: boolean;
}

/**
 * Identify recurring log message templates.
 */
export function detectPatterns(
    entries: EnrichedLogEntry[],
    options: PatternDetectorOptions = {},
): LogPattern[] {
    const topN = options.topN ?? 15;
    const excludeNoise = options.excludeNoise ?? true;

    const counts = new Map<string, { count: number; level: string; loggerName?: string }>();

    for (const entry of entries) {
        if (excludeNoise && isNoise(entry)) continue;

        const template = templatize(entry.message || '');
        const key = `${entry.priority}::${template}`;

        const existing = counts.get(key);
        if (existing) {
            existing.count++;
        } else {
            counts.set(key, { count: 1, level: entry.priority, loggerName: entry.loggerName });
        }
    }

    const total = excludeNoise ? entries.filter((e) => !isNoise(e)).length : entries.length;

    return [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, topN)
        .map(([key, val]) => ({
            template: key.split('::', 2)[1],
            count: val.count,
            level: val.level,
            percentage: total > 0 ? Math.round((val.count / total) * 10000) / 100 : 0,
            loggerName: val.loggerName,
        }));
}
