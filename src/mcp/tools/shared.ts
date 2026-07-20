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

/** Build a standard MCP text response from a string or a JSON-serializable value. */
export function mcpText(payload: unknown) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text }] };
}

/**
 * Build the dry-run preview response returned by a mutating deploy tool when the caller
 * has not passed `confirm: true`. Over stdio there is no interactive prompt, so the
 * safety model is: preview by default, mutate only on explicit confirm.
 */
export function dryRunPreview(preview: Record<string, unknown>) {
    return mcpText({
        dryRun: true,
        message: '⚠️ Dry run — nothing was changed. Review the preview and re-call with confirm: true to apply.',
        ...preview,
    });
}
