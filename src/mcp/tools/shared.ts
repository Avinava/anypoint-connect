/**
 * Shared MCP tool utilities
 * Common helpers used across all MCP tool registrars
 */

import type { AnypointClient } from '../../client/AnypointClient.js';
import type { Environment } from '../../api/AccessManagementApi.js';
import { errorMessage } from '../../utils/errors.js';

/** Resolve the default org and an environment name or ID in one step. */
export async function resolveEnvironment(
    client: AnypointClient,
    environment: string,
): Promise<{ orgId: string; env: Environment }> {
    const orgId = await client.getDefaultOrgId();
    const env = await client.accessManagement.resolveEnvironment(orgId, environment);
    return { orgId, env };
}

/** A look-back window ending now, as epoch milliseconds plus ISO strings for responses. */
export function timeWindow(hoursBack = 24): { from: number; to: number; period: { from: string; to: string } } {
    const to = Date.now();
    const from = to - hoursBack * 60 * 60 * 1000;
    return { from, to, period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() } };
}

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
