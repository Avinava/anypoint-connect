/**
 * Production pre-approval
 * Lets a user approve production writes ahead of time in .anypoint-connect.json, for named
 * environments and named tools, optionally until a date:
 *
 *   "productionPreapproval": {
 *     "environments": ["Production"],
 *     "tools": ["update_app", "deploy_jar"],      // or "all-mutating"
 *     "expires": "2026-12-31T00:00:00Z"            // optional
 *   }
 *
 * A covered write does not need confirmProduction (MCP) or the typed phrase (CLI). Nothing else
 * changes: previews stay the default, confirm: true is still required, bound IDs and digests are
 * still checked, and refusals (such as a jar not marked production deployable) still apply.
 */

import { findProjectConfigFile, discoverProjectConfig } from '../config/profiles.js';

/** Tools whose production confirmation can be pre-approved. The CLI uses the same names. */
export const PREAPPROVABLE_TOOLS = [
    'deploy_jar',
    'deploy_app',
    'update_app',
    'update_app_artifact',
    'rollback_app',
    'update_app_settings',
    'restart_app',
    'scale_app',
    'stop_app',
    'start_app',
    'smoke_test_api',
    'delete_app',
] as const;
export type PreapprovableTool = (typeof PREAPPROVABLE_TOOLS)[number];

export const ALL_MUTATING = 'all-mutating';

/** Tools that "all-mutating" does not cover; they are pre-approved only when named. */
export const NAMED_ONLY_TOOLS: readonly PreapprovableTool[] = ['delete_app'];

export interface ProductionPreapproval {
    /** Exact environment names or IDs (case-insensitive names, no wildcards). */
    environments: string[];
    tools: PreapprovableTool[] | typeof ALL_MUTATING;
    /** ISO 8601 date-time; the entry is ignored from then on. */
    expires?: string;
}

/** Validate one pre-approval entry. Throws with every problem found. */
export function validatePreapproval(input: unknown): ProductionPreapproval {
    const errors: string[] = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('productionPreapproval must be an object with environments, tools and optional expires');
    }
    const { environments, tools, expires, ...rest } = input as Record<string, unknown>;
    if (Object.keys(rest).length) errors.push(`unknown fields: ${Object.keys(rest).join(', ')}`);

    if (!Array.isArray(environments) || environments.length === 0) {
        errors.push('environments must be a non-empty list of environment names');
    } else {
        for (const env of environments) {
            if (typeof env !== 'string' || !env.trim()) errors.push('environments must hold non-empty names');
            else if (/[*?]/.test(env)) errors.push(`"${env}": wildcards are not allowed; name each environment`);
        }
    }

    if (tools !== ALL_MUTATING) {
        if (!Array.isArray(tools) || tools.length === 0) {
            errors.push(`tools must be "${ALL_MUTATING}" or a non-empty list of tool names`);
        } else {
            for (const tool of tools) {
                if (!PREAPPROVABLE_TOOLS.includes(tool as PreapprovableTool)) {
                    errors.push(`"${String(tool)}" is not a pre-approvable tool (${PREAPPROVABLE_TOOLS.join(', ')})`);
                }
            }
        }
    }

    if (expires !== undefined && (typeof expires !== 'string' || Number.isNaN(Date.parse(expires)))) {
        errors.push('expires must be an ISO 8601 date-time');
    }
    if (errors.length) throw new Error(`Invalid productionPreapproval:\n- ${errors.join('\n- ')}`);
    return {
        environments: (environments as string[]).map((e) => e.trim()),
        tools: tools === ALL_MUTATING ? ALL_MUTATING : [...new Set(tools as PreapprovableTool[])],
        ...(expires !== undefined ? { expires: expires as string } : {}),
    };
}

export interface PreapprovalEntryView extends ProductionPreapproval {
    expired: boolean;
}

export interface PreapprovalState {
    /** The .anypoint-connect.json the entries came from. */
    source?: string;
    entries: PreapprovalEntryView[];
    /** Entries that failed validation, which are ignored. */
    invalid: string[];
}

/** Read the pre-approval of the project config nearest to `startDir` (default: the working directory). */
export function readPreapproval(options: { startDir?: string; now?: number } = {}): PreapprovalState {
    const source = findProjectConfigFile(options.startDir) ?? undefined;
    const raw = source ? discoverProjectConfig(options.startDir)?.productionPreapproval : undefined;
    const state: PreapprovalState = { ...(source ? { source } : {}), entries: [], invalid: [] };
    if (raw === undefined) return state;
    const now = options.now ?? Date.now();
    for (const item of Array.isArray(raw) ? raw : [raw]) {
        try {
            const entry = validatePreapproval(item);
            state.entries.push({ ...entry, expired: entry.expires !== undefined && Date.parse(entry.expires) <= now });
        } catch (error) {
            state.invalid.push((error as Error).message);
        }
    }
    return state;
}

function coversTool(entry: ProductionPreapproval, tool: string): boolean {
    if (entry.tools === ALL_MUTATING) {
        return (
            PREAPPROVABLE_TOOLS.includes(tool as PreapprovableTool) &&
            !NAMED_ONLY_TOOLS.includes(tool as PreapprovableTool)
        );
    }
    return entry.tools.includes(tool as PreapprovableTool);
}

function coversEnv(entry: ProductionPreapproval, env: { name: string; id?: string }): boolean {
    return entry.environments.some((name) => name.toLowerCase() === env.name.toLowerCase() || name === env.id);
}

export interface PreapprovalDecision {
    productionPreapproved: boolean;
    /** Where the matching entry lives, when one matched. */
    preapprovalSource?: string;
    preapprovalExpires?: string;
}

/** Whether a production write by `tool` to `env` is pre-approved by a current entry. */
export function checkPreapproval(
    env: { name: string; id?: string },
    tool: string,
    options: { startDir?: string; now?: number; state?: PreapprovalState } = {},
): PreapprovalDecision {
    const state = options.state ?? readPreapproval(options);
    const match = state.entries.find((e) => !e.expired && coversEnv(e, env) && coversTool(e, tool));
    if (!match) return { productionPreapproved: false };
    return {
        productionPreapproved: true,
        preapprovalSource: `${state.source ?? '.anypoint-connect.json'} productionPreapproval`,
        ...(match.expires ? { preapprovalExpires: match.expires } : {}),
    };
}
