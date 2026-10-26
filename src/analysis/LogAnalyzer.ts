/**
 * Log Analyzer — Orchestrator
 * Thin pipeline that composes the individual analysis modules.
 *
 * Module structure:
 *  - types.ts          — Shared type definitions
 *  - utils.ts          — Noise detection, templatization, constants
 *  - parser.ts         — Multi-line log parser (JSON Logger, stack traces)
 *  - error-context.ts  — Error context window builder
 *  - error-grouper.ts  — Clusters similar errors
 *  - pattern-detector.ts — Identifies recurring message templates
 *  - stats.ts          — Level distribution, error rate, spike detection, histogram
 *  - filter.ts         - Time, level, logger and text filters shared by every log surface
 */

// Re-export all types
export type {
    EnrichedLogEntry,
    ErrorWithContext,
    ErrorGroup,
    LogPattern,
    ErrorSpike,
    LogStats,
    AnalysisOptions,
    AnalysisResult,
} from './types.js';

// Re-export individual modules for direct use
export { parseRawLogs } from './parser.js';
export { buildErrorContexts } from './error-context.js';
export { groupErrors } from './error-grouper.js';
export { detectPatterns } from './pattern-detector.js';
export { calculateStats, histogram, topCounts, BUCKETS, type Bucket, type HistogramBucket } from './stats.js';
export { templatize, isNoise, LEVEL_PRIORITY } from './normalize.js';
export {
    buildFilter,
    filterEntries,
    searchEntries,
    entryText,
    clampLimit,
    MAX_LOG_LINES,
    type LogFilter,
    type LogSearchOptions,
    type LogSearchResult,
} from './filter.js';

export {
    summarizeEntries,
    formatEntry,
    formatEntries,
    MAX_HISTOGRAM_ROWS,
    type LogSummary,
    type SummaryOptions,
} from './summary.js';

// Pipeline imports
import type { AnalysisOptions, AnalysisResult } from './types.js';
import { parseRawLogs } from './parser.js';
import { buildErrorContexts } from './error-context.js';
import { groupErrors } from './error-grouper.js';
import { detectPatterns } from './pattern-detector.js';
import { calculateStats } from './stats.js';
import { buildFilter, levelPriority } from './filter.js';
import { LEVEL_PRIORITY } from './normalize.js';

/**
 * Full analysis pipeline: parse → filter → context → group → pattern → stats.
 * The time window applies to everything. Level, logger and search select the entries
 * that are counted and analyzed as errors; error context still comes from every entry
 * in the window, so a filtered error keeps the lines that led up to it.
 */
export function analyzeLogs(rawText: string, options: AnalysisOptions = {}): AnalysisResult {
    const totalLines = rawText.split('\n').length;

    // 1. Parse and join multi-line entries
    const parsed = parseRawLogs(rawText);

    // 2. Time window
    const startTime =
        options.startTime ?? (options.hoursBack ? Date.now() - options.hoursBack * 60 * 60 * 1000 : undefined);
    const inWindow = buildFilter({ startTime, endTime: options.endTime });
    const windowed = parsed.filter(inWindow);

    // 3. Level, logger and search
    const selected = buildFilter({
        level: options.level,
        logger: options.logger,
        search: options.search,
        regex: options.regex,
    });
    const entries = windowed.filter(selected);

    // 4. Build error contexts over the whole window
    const minErrorLevel = levelPriority(options.errorLevel ?? 'ERROR');
    const errorContexts = buildErrorContexts(windowed, {
        beforeCount: options.contextBefore,
        afterCount: options.contextAfter,
        isError: (e) => (LEVEL_PRIORITY[e.priority] ?? 0) >= minErrorLevel && selected(e),
    });

    // 5. Group errors
    const errorGroups = groupErrors(errorContexts, {
        maxGroups: options.maxErrorGroups,
    });

    // 6. Detect patterns
    const patterns = detectPatterns(entries, {
        topN: options.maxPatterns,
    });

    // 7. Calculate stats
    const stats = calculateStats(entries, totalLines, errorGroups, patterns);

    return { entries, errorContexts, errorGroups, patterns, stats };
}
