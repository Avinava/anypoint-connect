/**
 * Log Analysis — Error Context
 * Builds before/after context windows for ERROR entries.
 * Uses correlation-based context when available, time-window fallback otherwise.
 */

import type { EnrichedLogEntry, ErrorWithContext } from './types.js';

export interface ErrorContextOptions {
    /** Number of entries to capture before the error (default: 15) */
    beforeCount?: number;
    /** Number of entries to capture after the error (default: 10) */
    afterCount?: number;
    /** Time window in ms for fallback mode (default: 30000) */
    timeWindowMs?: number;
}

/**
 * Build error context for all ERROR entries.
 */
export function buildErrorContexts(entries: EnrichedLogEntry[], options: ErrorContextOptions = {}): ErrorWithContext[] {
    const beforeCount = options.beforeCount ?? 15;
    const afterCount = options.afterCount ?? 10;
    const timeWindowMs = options.timeWindowMs ?? 30000;

    const errorEntries = entries.filter((e) => e.priority === 'ERROR');
    const contexts: ErrorWithContext[] = [];

    // Build correlation index for fast lookup
    const correlationIndex = new Map<string, EnrichedLogEntry[]>();
    for (const entry of entries) {
        if (entry.correlationId) {
            let group = correlationIndex.get(entry.correlationId);
            if (!group) {
                group = [];
                correlationIndex.set(entry.correlationId, group);
            }
            group.push(entry);
        }
    }

    for (const error of errorEntries) {
        let before: EnrichedLogEntry[];
        let after: EnrichedLogEntry[];
        let correlationId: string | undefined;

        if (error.correlationId && correlationIndex.has(error.correlationId)) {
            // Correlation-based context — follow the full request lifecycle
            correlationId = error.correlationId;
            const correlated = correlationIndex.get(correlationId)!;
            const errorIdx = correlated.indexOf(error);
            before = correlated.slice(Math.max(0, errorIdx - beforeCount), errorIdx);
            after = correlated.slice(errorIdx + 1, errorIdx + 1 + afterCount);
        } else {
            // Time-window fallback
            const errorIdx = entries.indexOf(error);
            before = entries
                .slice(Math.max(0, errorIdx - beforeCount), errorIdx)
                .filter((e) => error.timestamp - e.timestamp <= timeWindowMs);
            after = entries
                .slice(errorIdx + 1, errorIdx + 1 + afterCount)
                .filter((e) => e.timestamp - error.timestamp <= timeWindowMs);
        }

        const flowTrace = buildFlowTrace(before, error);
        contexts.push({ error, before, after, correlationId, flowTrace });
    }

    return contexts;
}

/**
 * Extract the flow execution path from context entries.
 */
function buildFlowTrace(before: EnrichedLogEntry[], error: EnrichedLogEntry): string[] {
    const flows: string[] = [];
    const seen = new Set<string>();

    for (const entry of [...before, error]) {
        const flow = entry.flowName;
        if (flow && !seen.has(flow)) {
            seen.add(flow);
            flows.push(flow);
        }
    }

    return flows;
}
