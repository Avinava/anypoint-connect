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
 *  - stats.ts          — Level distribution, error rate, spike detection
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
export { calculateStats } from './stats.js';
export { templatize, isNoise, LEVEL_PRIORITY } from './utils.js';

// Pipeline imports
import type { AnalysisOptions, AnalysisResult } from './types.js';
import { LEVEL_PRIORITY } from './utils.js';
import { parseRawLogs } from './parser.js';
import { buildErrorContexts } from './error-context.js';
import { groupErrors } from './error-grouper.js';
import { detectPatterns } from './pattern-detector.js';
import { calculateStats } from './stats.js';

/**
 * Full analysis pipeline: parse → enrich → context → group → pattern → stats.
 */
export function analyzeLogs(rawText: string, options: AnalysisOptions = {}): AnalysisResult {
    const totalLines = rawText.split('\n').length;

    // 1. Parse and join multi-line entries
    let entries = parseRawLogs(rawText);

    // 2. Filter by time if requested
    if (options.hoursBack) {
        const cutoff = Date.now() - options.hoursBack * 60 * 60 * 1000;
        entries = entries.filter((e) => e.timestamp >= cutoff);
    }

    // 3. Filter by level if requested
    if (options.level) {
        const minLevel = LEVEL_PRIORITY[options.level.toUpperCase()] ?? 0;
        entries = entries.filter((e) => (LEVEL_PRIORITY[e.priority] ?? 0) >= minLevel);
    }

    // 4. Build error contexts
    const errorContexts = buildErrorContexts(entries, {
        beforeCount: options.contextBefore,
        afterCount: options.contextAfter,
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
