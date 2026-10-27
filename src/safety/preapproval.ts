/**
 * Production policy: pre-approvals and unmarked-artifact allowances
 *
 * Both live only in the user-level store, ~/.anypoint-connect/production-approvals.json, outside any
 * repository, so a branch cannot plant or widen one. Every entry is bound to a resolved organization
 * ID and environment ID; names are kept for display only and never matched. A `productionPreapproval`
 * found in a project's .anypoint-connect.json is ignored and reported.
 *
 *   {
 *     "productionPreapprovals": [
 *       { "orgId": "...", "environmentId": "...", "environmentName": "Production",
 *         "tools": ["update_app"] | "all-mutating", "expires": "2026-12-31T00:00:00Z", "projectPath": "/abs/repo" }
 *     ],
 *     "unmarkedArtifactAllowances": [
 *       { "orgId": "...", "environmentId": "...", "environmentName": "Production", "expires": "...", "projectPath": "..." }
 *     ]
 *   }
 *
 * A pre-approval stands in for confirmProduction (MCP) and the typed phrase (CLI). An allowance lets
 * jars without a build marker go to that environment. Neither waives confirm: true, bound IDs,
 * digests, or the refusal of a jar marked not production deployable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverProjectConfig, findProjectConfigFile, getConfigDir } from '../config/profiles.js';
import { resolveProjectRoot } from './paths.js';

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

export const APPROVALS_FILE_NAME = 'production-approvals.json';

export interface ScopedEntry {
    orgId: string;
    environmentId: string;
    /** Display only; never matched. */
    environmentName?: string;
    /** ISO 8601 date-time; the entry is ignored from then on. */
    expires?: string;
    /** Absolute project root; when set, the entry applies only to tools run in that project. */
    projectPath?: string;
}

export interface ProductionPreapproval extends ScopedEntry {
    tools: PreapprovableTool[] | typeof ALL_MUTATING;
}

export type UnmarkedArtifactAllowance = ScopedEntry;

export interface ApprovalStore {
    productionPreapprovals?: ProductionPreapproval[];
    unmarkedArtifactAllowances?: UnmarkedArtifactAllowance[];
}

/** The user-level store path. */
export function approvalsFile(): string {
    return path.join(getConfigDir(), APPROVALS_FILE_NAME);
}

function validateScope(input: Record<string, unknown>, errors: string[]): ScopedEntry {
    const { orgId, environmentId, environmentName, expires, projectPath } = input;
    for (const [name, value] of [
        ['orgId', orgId],
        ['environmentId', environmentId],
    ] as const) {
        if (typeof value !== 'string' || !value.trim()) errors.push(`${name} must be a non-empty ID`);
        else if (/[*?]/.test(value)) errors.push(`${name}: wildcards are not allowed`);
    }
    if (environmentName !== undefined && typeof environmentName !== 'string')
        errors.push('environmentName must be a string');
    if (expires !== undefined && (typeof expires !== 'string' || Number.isNaN(Date.parse(expires)))) {
        errors.push('expires must be an ISO 8601 date-time');
    }
    if (projectPath !== undefined && (typeof projectPath !== 'string' || !path.isAbsolute(projectPath))) {
        errors.push('projectPath must be an absolute path');
    }
    return {
        orgId: orgId as string,
        environmentId: environmentId as string,
        ...(environmentName !== undefined ? { environmentName: environmentName as string } : {}),
        ...(expires !== undefined ? { expires: expires as string } : {}),
        ...(projectPath !== undefined ? { projectPath: projectPath as string } : {}),
    };
}

function asObject(input: unknown, what: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${what} must be an object`);
    return input as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, allowed: string[], errors: string[]) {
    const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
    if (unknown.length) errors.push(`unknown fields: ${unknown.join(', ')}`);
}

const SCOPE_FIELDS = ['orgId', 'environmentId', 'environmentName', 'expires', 'projectPath'];

/** Validate one pre-approval entry. Throws with every problem found. */
export function validatePreapproval(input: unknown): ProductionPreapproval {
    const object = asObject(input, 'A production pre-approval');
    const errors: string[] = [];
    rejectUnknown(object, [...SCOPE_FIELDS, 'tools'], errors);
    const scope = validateScope(object, errors);
    const { tools } = object;
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
    if (errors.length) throw new Error(`Invalid production pre-approval:\n- ${errors.join('\n- ')}`);
    return { ...scope, tools: tools === ALL_MUTATING ? ALL_MUTATING : [...new Set(tools as PreapprovableTool[])] };
}

/** Validate one unmarked-artifact allowance. Throws with every problem found. */
export function validateUnmarkedAllowance(input: unknown): UnmarkedArtifactAllowance {
    const object = asObject(input, 'An unmarked-artifact allowance');
    const errors: string[] = [];
    rejectUnknown(object, SCOPE_FIELDS, errors);
    const scope = validateScope(object, errors);
    if (errors.length) throw new Error(`Invalid unmarked-artifact allowance:\n- ${errors.join('\n- ')}`);
    return scope;
}

export type EntryView<T> = T & { expired: boolean };

export interface ApprovalState {
    source: string;
    productionPreapprovals: EntryView<ProductionPreapproval>[];
    unmarkedArtifactAllowances: EntryView<UnmarkedArtifactAllowance>[];
    /** Entries or files that failed validation; they are ignored. */
    invalid: string[];
}

function readRawStore(file: string): { store: ApprovalStore; invalid: string[] } {
    if (!fs.existsSync(file)) return { store: {}, invalid: [] };
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { store: asObject(parsed, file) as ApprovalStore, invalid: [] };
    } catch (error) {
        return { store: {}, invalid: [`${file} is unreadable: ${(error as Error).message}`] };
    }
}

/** Read and validate the user-level store. */
export function readApprovalState(options: { now?: number } = {}): ApprovalState {
    const source = approvalsFile();
    const { store, invalid } = readRawStore(source);
    const now = options.now ?? Date.now();
    const expired = (expires?: string) => expires !== undefined && Date.parse(expires) <= now;
    const state: ApprovalState = { source, productionPreapprovals: [], unmarkedArtifactAllowances: [], invalid };
    for (const item of Array.isArray(store.productionPreapprovals) ? store.productionPreapprovals : []) {
        try {
            const entry = validatePreapproval(item);
            state.productionPreapprovals.push({ ...entry, expired: expired(entry.expires) });
        } catch (error) {
            state.invalid.push((error as Error).message);
        }
    }
    for (const item of Array.isArray(store.unmarkedArtifactAllowances) ? store.unmarkedArtifactAllowances : []) {
        try {
            const entry = validateUnmarkedAllowance(item);
            state.unmarkedArtifactAllowances.push({ ...entry, expired: expired(entry.expires) });
        } catch (error) {
            state.invalid.push((error as Error).message);
        }
    }
    return state;
}

function sameScope(a: ScopedEntry, b: ScopedEntry): boolean {
    return a.orgId === b.orgId && a.environmentId === b.environmentId && a.projectPath === b.projectPath;
}

/** Replace (or, with `entry` null, remove) the entry with the same org, environment and project. */
function upsert<T extends ScopedEntry>(list: T[] | undefined, scope: ScopedEntry, entry: T | null): T[] {
    const rest = (list ?? []).filter((item) => !sameScope(item, scope));
    return entry ? [...rest, entry] : rest;
}

function writeStore(update: (store: ApprovalStore) => ApprovalStore): string {
    const file = approvalsFile();
    const { store, invalid } = readRawStore(file);
    if (invalid.length) throw new Error(`${invalid[0]}; fix or remove it first`);
    fs.writeFileSync(file, JSON.stringify(update(store), null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
}

/** Store a pre-approval (replacing one with the same scope), or remove it when `entry` is null. */
export function savePreapproval(scope: ScopedEntry, entry: ProductionPreapproval | null): string {
    const valid = entry ? validatePreapproval(entry) : null;
    return writeStore((store) => ({
        ...store,
        productionPreapprovals: upsert(store.productionPreapprovals, scope, valid),
    }));
}

/** Store an unmarked-artifact allowance (replacing one with the same scope), or remove it. */
export function saveUnmarkedAllowance(scope: ScopedEntry, entry: UnmarkedArtifactAllowance | null): string {
    const valid = entry ? validateUnmarkedAllowance(entry) : null;
    return writeStore((store) => ({
        ...store,
        unmarkedArtifactAllowances: upsert(store.unmarkedArtifactAllowances, scope, valid),
    }));
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

export interface PolicyTarget {
    orgId: string;
    env: { id: string };
}

interface MatchOptions {
    now?: number;
    state?: ApprovalState;
    /** The current project root; resolved only when an entry is project-scoped. */
    projectRoot?: string;
}

function matcher(target: PolicyTarget, options: MatchOptions) {
    let root = options.projectRoot;
    const projectMatches = (projectPath?: string) => {
        if (!projectPath) return true;
        root ??= resolveProjectRoot();
        return path.resolve(projectPath) === path.resolve(root);
    };
    return (entry: EntryView<ScopedEntry>) =>
        !entry.expired &&
        entry.orgId === target.orgId &&
        entry.environmentId === target.env.id &&
        projectMatches(entry.projectPath);
}

export interface PreapprovalDecision {
    productionPreapproved: boolean;
    /** Where the matching entry lives, when one matched. */
    preapprovalSource?: string;
    preapprovalExpires?: string;
}

/** Whether a production write by `tool` to the target org and environment is pre-approved. */
export function checkPreapproval(target: PolicyTarget, tool: string, options: MatchOptions = {}): PreapprovalDecision {
    const state = options.state ?? readApprovalState(options);
    const inScope = matcher(target, options);
    const match = state.productionPreapprovals.find((e) => inScope(e) && coversTool(e, tool));
    if (!match) return { productionPreapproved: false };
    return {
        productionPreapproved: true,
        preapprovalSource: `${state.source} productionPreapprovals`,
        ...(match.expires ? { preapprovalExpires: match.expires } : {}),
    };
}

export interface UnmarkedDecision {
    unmarkedAllowed: boolean;
    source?: string;
    expires?: string;
}

/** Whether jars without a build marker may go to the target org and environment. */
export function checkUnmarkedAllowance(target: PolicyTarget, options: MatchOptions = {}): UnmarkedDecision {
    const state = options.state ?? readApprovalState(options);
    const match = state.unmarkedArtifactAllowances.find(matcher(target, options));
    if (!match) return { unmarkedAllowed: false };
    return {
        unmarkedAllowed: true,
        source: `${state.source} unmarkedArtifactAllowances`,
        ...(match.expires ? { expires: match.expires } : {}),
    };
}

/** A warning when the project's .anypoint-connect.json carries an approval, which is never honored. */
export function ignoredProjectApprovalWarning(startDir?: string): string | undefined {
    const config = discoverProjectConfig(startDir) as Record<string, unknown> | null;
    if (!config) return undefined;
    const keys = ['productionPreapproval', 'productionPreapprovals', 'unmarkedArtifactAllowances'].filter(
        (key) => config[key] !== undefined,
    );
    if (!keys.length) return undefined;
    return `${findProjectConfigFile(startDir)} contains ${keys.join(', ')}, which is ignored: production approvals are read only from ${approvalsFile()}`;
}
