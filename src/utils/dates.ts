/**
 * Date utilities
 * Shared date-parsing helpers for CLI commands
 */

/**
 * Parses a date string into a Unix timestamp (milliseconds).
 *
 * Supports:
 * - Relative durations: `"30m"`, `"2h"`, `"7d"` (minutes, hours, days ago)
 * - ISO 8601 dates: `"2024-01-15T10:30:00Z"`
 * - Any string accepted by `Date.parse()`
 *
 * @throws {Error} If the string is not a valid date or relative format
 */
export function parseDate(dateStr: string): number {
    const relativeMatch = dateStr.match(/^(\d+)(m|h|d)$/);
    if (relativeMatch) {
        const amount = parseInt(relativeMatch[1]);
        const unit = relativeMatch[2];
        const now = Date.now();
        switch (unit) {
            case 'm':
                return now - amount * 60 * 1000;
            case 'h':
                return now - amount * 60 * 60 * 1000;
            case 'd':
                return now - amount * 24 * 60 * 60 * 1000;
        }
    }

    const ts = Date.parse(dateStr);
    if (isNaN(ts)) {
        throw new Error(`Invalid date: "${dateStr}". Use ISO format or relative (e.g., 1h, 30m, 2d)`);
    }
    return ts;
}
