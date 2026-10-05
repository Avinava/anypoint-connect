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
        if (data && typeof data === 'object') {
            if ('message' in data) return String((data as { message: string }).message);
            // Some APIs return { error: '...' } or { status, ... } — show full body
            return `HTTP ${error.response.status}: ${JSON.stringify(data)}`;
        }
        return `HTTP ${error.response.status || 'unknown'}`;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * A metrics query the monitoring service rejected or could not run. Carries the platform's own
 * message (syntax errors, unknown datasources or attributes, oversized limits) so callers never
 * mistake a broken query for "no data".
 */
export class AmqlQueryError extends Error {
    constructor(
        message: string,
        readonly query: string,
        readonly status?: number,
        readonly transactionId?: string,
    ) {
        super(message);
        this.name = 'AmqlQueryError';
    }

    static from(error: unknown, query: string): AmqlQueryError {
        if (error instanceof AxiosError && error.response) {
            const data = error.response.data as { message?: unknown; 'X-ANYPNT-TRX-ID'?: unknown } | undefined;
            const detail = typeof data?.message === 'string' ? data.message : errorMessage(error);
            const transactionId = typeof data?.['X-ANYPNT-TRX-ID'] === 'string' ? data['X-ANYPNT-TRX-ID'] : undefined;
            return new AmqlQueryError(
                `AMQL query failed (HTTP ${error.response.status}): ${detail}`,
                query,
                error.response.status,
                transactionId,
            );
        }
        return new AmqlQueryError(`AMQL query failed: ${errorMessage(error)}`, query);
    }
}
