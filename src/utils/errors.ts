/**
 * Error utilities
 * Shared error formatting for CLI and MCP error handling
 */

import { AxiosError } from 'axios';

/**
 * Extracts a human-readable message from an unknown error value.
 * For AxiosErrors, prefers the API response body (which often contains
 * a more descriptive message than the generic HTTP status).
 * Safely handles Error instances, strings, and other types.
 */
export function errorMessage(error: unknown): string {
    if (error instanceof AxiosError && error.response) {
        const data = error.response.data;
        if (typeof data === 'string' && data.length > 0) return data;
        if (data && typeof data === 'object' && 'message' in data) return String((data as { message: string }).message);
        return `HTTP ${error.response.status || 'unknown'}`;
    }
    return error instanceof Error ? error.message : String(error);
}
