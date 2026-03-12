/**
 * Log Analysis — Error Grouper
 * Clusters similar errors by (errorType + message template).
 */

import type { ErrorWithContext, ErrorGroup } from './types.js';
import { templatize } from './utils.js';

export interface ErrorGrouperOptions {
    /** Maximum samples per group (default: 3) */
    maxSamples?: number;
    /** Maximum groups to return (default: 10) */
    maxGroups?: number;
}

/**
 * Group similar errors by error type and message pattern.
 */
export function groupErrors(contexts: ErrorWithContext[], options: ErrorGrouperOptions = {}): ErrorGroup[] {
    const maxSamples = options.maxSamples ?? 3;
    const maxGroups = options.maxGroups ?? 10;

    const groups = new Map<string, { contexts: ErrorWithContext[]; flows: Set<string> }>();

    for (const ctx of contexts) {
        const errorType = ctx.error.errorType || 'UNKNOWN';
        const template = templatize(ctx.error.message || '');
        const key = `${errorType}::${template}`;

        let group = groups.get(key);
        if (!group) {
            group = { contexts: [], flows: new Set() };
            groups.set(key, group);
        }
        group.contexts.push(ctx);
        if (ctx.error.flowName) {
            group.flows.add(ctx.error.flowName);
        }
    }

    const sorted = [...groups.entries()]
        .sort((a, b) => b[1].contexts.length - a[1].contexts.length)
        .slice(0, maxGroups);

    return sorted.map(([key, group]) => {
        const [errorType, template] = key.split('::', 2);
        const timestamps = group.contexts.map((c) => c.error.timestamp).sort();

        return {
            errorType,
            template,
            count: group.contexts.length,
            firstSeen: new Date(timestamps[0]).toISOString(),
            lastSeen: new Date(timestamps[timestamps.length - 1]).toISOString(),
            samples: group.contexts.slice(0, maxSamples),
            affectedFlows: [...group.flows],
        };
    });
}
