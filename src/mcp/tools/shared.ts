/**
 * Shared MCP tool utilities
 * Common helpers used across all MCP tool registrars
 */

import { errorMessage } from '../../utils/errors.js';

/**
 * Build a standard MCP error response.
 * Every tool handler catch block should return this.
 */
export function mcpError(error: unknown) {
    return {
        content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }],
        isError: true as const,
    };
}
