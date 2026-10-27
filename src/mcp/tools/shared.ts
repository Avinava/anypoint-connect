/**
 * Shared MCP tool utilities
 * Common helpers used across all MCP tool registrars
 */

import type { AnypointClient } from '../../client/AnypointClient.js';
import type { Environment } from '../../api/AccessManagementApi.js';
import { z } from 'zod';
import { errorMessage } from '../../utils/errors.js';
import { isProductionEnv } from '../../safety/guards.js';
import { checkPreapproval } from '../../safety/preapproval.js';

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

/** Inputs every mutating tool accepts: preview by default, apply on confirm, and a second flag for production. */
export const writeInputs = {
    confirm: z
        .boolean()
        .optional()
        .describe('Apply the change. Without it the tool returns a preview and changes nothing'),
    confirmProduction: z
        .boolean()
        .optional()
        .describe('Required in addition to confirm when the target environment is production'),
};

type GuardEnv = Pick<Environment, 'name' | 'isProduction'> & { id?: string };

/**
 * Production fields for previews and results: `production`, whether a project pre-approval covers
 * this tool and environment, and where it is configured. Empty outside production.
 */
export function productionFields(
    env: GuardEnv,
    tool: string,
): { production?: true; productionPreapproved?: boolean; preapprovalSource?: string; preapprovalExpires?: string } {
    if (!isProductionEnv(env.name, env.isProduction)) return {};
    const decision = checkPreapproval(env, tool);
    return {
        production: true as const,
        productionPreapproved: decision.productionPreapproved,
        ...(decision.preapprovalSource ? { preapprovalSource: decision.preapprovalSource } : {}),
        ...(decision.preapprovalExpires ? { preapprovalExpires: decision.preapprovalExpires } : {}),
    };
}

/**
 * Gate a write. Returns the response to send instead of writing (a preview, or a refusal for
 * production without `confirmProduction`), or `null` when the caller may proceed. A project
 * pre-approval covering `tool` and the environment stands in for `confirmProduction`; `confirm`
 * is always required.
 */
export function guardWrite(input: {
    env: GuardEnv;
    /** The MCP tool name, matched against productionPreapproval. */
    tool: string;
    confirm?: boolean;
    confirmProduction?: boolean;
    preview: Record<string, unknown>;
}) {
    const production = productionFields(input.env, input.tool);
    const preapproved = production.productionPreapproved === true;
    if (!input.confirm) {
        return dryRunPreview({
            ...input.preview,
            ...production,
            ...(production.production
                ? { requires: preapproved ? 'confirm: true' : 'confirm: true and confirmProduction: true' }
                : {}),
        });
    }
    if (production.production && !preapproved && !input.confirmProduction) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(
                        {
                            refused: true,
                            message: `${input.env.name} is a production environment. Nothing was changed. Re-call with confirm: true and confirmProduction: true to apply.`,
                            ...input.preview,
                            ...production,
                        },
                        null,
                        2,
                    ),
                },
            ],
            isError: true as const,
        };
    }
    return null;
}
