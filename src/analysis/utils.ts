/**
 * Log Analysis — Utilities
 * Shared helpers: noise detection, templatization, constants.
 */

import type { EnrichedLogEntry } from './types.js';

/** Variable-like tokens to replace with <*> in pattern detection */
const VARIABLE_PATTERNS = [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUIDs
    /\b[a-zA-Z0-9]{15,18}\b/g, // Salesforce IDs
    /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, // ISO timestamps
    /\b\d+\.\d+\.\d+\.\d+\b/g, // IP addresses
    /\b\d{5,}\b/g, // Long numbers (5+ digits)
    /\b0x[0-9a-fA-F]+\b/g, // Hex addresses
    /@ ?[0-9a-f]{6,8}\b/g, // Object hash references like @5d035c54
];

/** HTTP listener noise pattern */
const HTTP_LISTENER_PATTERN = /^.*http\.listener\.\d+\s+-\s+\[/;

/** Numeric priority for log level filtering */
export const LEVEL_PRIORITY: Record<string, number> = {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    FATAL: 5,
};

/**
 * Replace variable tokens in a message with <*> for template grouping.
 */
export function templatize(message: string): string {
    let result = message;
    for (const pattern of VARIABLE_PATTERNS) {
        result = result.replace(pattern, '<*>');
    }
    result = result.replace(/(<\*>\s*){2,}/g, '<*> ');
    if (result.length > 200) {
        result = result.substring(0, 200) + '...';
    }
    return result.trim();
}

/**
 * Check if an entry is HTTP listener noise.
 */
export function isNoise(entry: EnrichedLogEntry): boolean {
    if (entry.priority === 'DEBUG' && entry.loggerName) {
        const name = entry.loggerName.toLowerCase();
        if (name.includes('http.listener') || name.includes('http-listener')) return true;
    }
    if (entry.priority === 'DEBUG' && entry.message) {
        if (HTTP_LISTENER_PATTERN.test(entry.message)) return true;
    }
    return false;
}
