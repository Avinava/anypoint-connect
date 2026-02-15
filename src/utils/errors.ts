/**
 * Error utilities
 * Shared error formatting for CLI and MCP error handling
 */

/**
 * Extracts a human-readable message from an unknown error value.
 * Safely handles Error instances, strings, and other types.
 */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
