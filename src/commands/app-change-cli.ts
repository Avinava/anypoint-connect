/**
 * CLI helpers for application changes
 * Shared flags and output for `anc apps update`, `anc apps settings set`, `anc apps restart` and
 * `anc deploy`. Secure values can only come from files or environment variables, never from
 * arguments, so they stay out of shell history.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { log } from '../utils/logger.js';
import { confirmProductionWrite } from '../safety/guards.js';
import type { SecretSource } from '../safety/secret-sources.js';
import type { RuntimeSpec } from '../safety/runtime.js';
import type { AppChangePlan, ChangeMode, SettingsChangeInput, UpdateStrategy } from '../workflows/app-change.js';
import { describeAppChange } from '../workflows/app-change.js';
import type { PhaseSnapshot } from '../workflows/app-state.js';

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Add the settings flags to a command. */
export function addSettingsOptions(command: Command): Command {
    return command
        .option('--set <key=value>', 'Set a plain property (repeatable)', collect)
        .option(
            '--from-file <path[:keys]>',
            'Plain properties from a project .env/.properties/JSON file (repeatable)',
            collect,
        )
        .option(
            '--secure-from-file <path[:keys]>',
            'Secure properties from a project .env/.properties/JSON file, optionally only the listed comma-separated keys (repeatable)',
            collect,
        )
        .option(
            '--secure-from-env <property=ENV_VAR>',
            'Secure property from an environment variable (repeatable)',
            collect,
        )
        .option('--remove <key>', 'Delete a plain property (repeatable)', collect)
        .option('--remove-secure <key>', 'Delete a secure property (repeatable)', collect)
        .option('--move-to-secure <key>', 'Move a plain property to secure, keeping its value (repeatable)', collect);
}

/** Add the runtime flags to a command. */
export function addRuntimeOptions(command: Command, prefix = ''): Command {
    return command
        .option('-r, --runtime <version>', `${prefix}Mule runtime version, e.g. 4.9.0 or 4.9`)
        .option('--java <version>', `${prefix}Java version for the runtime, e.g. 17`)
        .option('--release-channel <channel>', `${prefix}Release channel, e.g. LTS or EDGE`);
}

/** Add the mode, strategy and wait flags to a command. */
export function addRolloutOptions(command: Command): Command {
    return command
        .option('--stop-start', 'Stop, apply, start: old and new replicas never run together', false)
        .option('--update-strategy <strategy>', 'Persistently set the update strategy: rolling or recreate')
        .option('--no-wait', 'Return once the change is accepted instead of waiting for the rollout')
        .option('--timeout <seconds>', 'Wait limit in seconds (default 300)');
}

function parseFileSource(value: string): SecretSource {
    const match = /^(.*?)(?::([^:\\/]+))?$/.exec(value);
    const file = match?.[1] || value;
    const keys = match?.[2]
        ?.split(',')
        .map((key) => key.trim())
        .filter(Boolean);
    return { file, ...(keys?.length ? { keys } : {}) };
}

function parsePairs(values: string[] | undefined, flag: string): Record<string, string> {
    const pairs: Record<string, string> = {};
    for (const value of values ?? []) {
        const index = value.indexOf('=');
        if (index <= 0) throw new Error(`${flag} expects key=value, got "${value}"`);
        pairs[value.slice(0, index)] = value.slice(index + 1);
    }
    return pairs;
}

export interface SettingsOptions {
    set?: string[];
    fromFile?: string[];
    secureFromFile?: string[];
    secureFromEnv?: string[];
    remove?: string[];
    removeSecure?: string[];
    moveToSecure?: string[];
}

export function settingsFromOptions(opts: SettingsOptions): SettingsChangeInput {
    const properties = parsePairs(opts.set, '--set');
    const secureEnv = parsePairs(opts.secureFromEnv, '--secure-from-env');
    return {
        ...(Object.keys(properties).length ? { properties } : {}),
        ...(opts.fromFile?.length ? { propertiesFrom: opts.fromFile.map(parseFileSource) } : {}),
        securePropertiesFrom: [
            ...(opts.secureFromFile ?? []).map(parseFileSource),
            ...(Object.keys(secureEnv).length ? [{ env: secureEnv }] : []),
        ],
        removeProperties: opts.remove,
        removeSecureProperties: opts.removeSecure,
        moveToSecure: opts.moveToSecure,
    };
}

export function runtimeFromOptions(opts: {
    runtime?: string;
    java?: string;
    releaseChannel?: string;
}): RuntimeSpec | undefined {
    if (!opts.runtime) return undefined;
    return {
        version: opts.runtime,
        ...(opts.java ? { java: opts.java } : {}),
        ...(opts.releaseChannel ? { releaseChannel: opts.releaseChannel } : {}),
    };
}

export function rolloutFromOptions(opts: {
    stopStart?: boolean;
    updateStrategy?: string;
    wait?: boolean;
    timeout?: string;
}): {
    mode: ChangeMode;
    updateStrategy?: UpdateStrategy;
    wait: boolean;
    timeoutMs?: number;
} {
    if (opts.updateStrategy && !['rolling', 'recreate'].includes(opts.updateStrategy)) {
        throw new Error('--update-strategy must be rolling or recreate');
    }
    const timeout = opts.timeout ? parseInt(opts.timeout, 10) : undefined;
    if (timeout !== undefined && (isNaN(timeout) || timeout < 10))
        throw new Error('--timeout must be at least 10 seconds');
    return {
        mode: opts.stopStart ? 'stopStart' : 'inPlace',
        ...(opts.updateStrategy ? { updateStrategy: opts.updateStrategy as UpdateStrategy } : {}),
        wait: opts.wait !== false,
        ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
    };
}

/** Print an application change preview. Returns false when blockers stop the change. */
export function printAppChange(plan: AppChangePlan): boolean {
    const preview = describeAppChange(plan);
    log.header(`${preview.app} in ${preview.environment}${plan.production ? chalk.red(' (production)') : ''}`);
    log.kv('Mode', plan.mode === 'stopStart' ? 'stop, apply, start' : 'in place');
    log.kv(
        'Current',
        `${preview.current.ref.artifactId}:${preview.current.ref.version} on ${preview.current.runtime?.version ?? '-'} (${preview.current.phase})`,
    );
    for (const change of preview.changes)
        log.kv(`  ${change.field}`, `${String(change.from ?? '-')} -> ${String(change.to)}`);
    if (preview.settings) {
        const s = preview.settings;
        for (const c of s.added) log.kv('  + property', c.to === undefined ? c.key : `${c.key}=${c.to}`);
        for (const c of s.changed) log.kv('  ~ property', `${c.key}: ${c.from ?? ''} -> ${c.to ?? ''}`);
        for (const k of s.removed) log.kv('  - property', k);
        for (const k of s.secureAdded) log.kv('  + secure', k);
        for (const k of s.secureChanged) log.kv('  ~ secure', k);
        for (const k of s.secureRemoved) log.kv('  - secure', k);
        for (const k of s.movedToSecure) log.kv('  > secure', k);
    }
    if (!preview.runtimeCheck.checked) log.dim(`  Runtime not validated: ${preview.runtimeCheck.reason}`);
    const provenance = preview.buildProvenance;
    if (provenance?.status === 'recorded') {
        log.kv(
            'Build',
            `${provenance.tool} ${provenance.toolVersion}, stripped: ${provenance.stripped}, productionDeployable: ${provenance.productionDeployable}`,
        );
    } else if (provenance?.status === 'unknown') {
        log.dim(`  ${provenance.note ?? 'build provenance unknown'}`);
    }
    for (const step of preview.steps) log.dim(`  step: ${step}`);
    for (const warning of preview.warnings ?? []) log.warn(warning);
    for (const blocker of preview.blockers ?? []) log.error(blocker);
    if (plan.noop) log.info('Nothing to change.');
    return !preview.blockers?.length;
}

/**
 * Ask for confirmation in production unless forced or pre-approved for `tool` (the matching MCP
 * tool name). Returns false when declined.
 */
export async function confirmIfProduction(plan: AppChangePlan, force: boolean, tool: string): Promise<boolean> {
    if (!plan.production) return true;
    return confirmProductionWrite({ ...plan.request.env, isProduction: true }, tool, force);
}

/** A spinner that follows a rollout. */
export function rolloutSpinner(text: string) {
    const spinner = ora(text).start();
    return {
        spinner,
        onStatus: (step: string, snapshot: PhaseSnapshot) => {
            spinner.text = `${step}: ${snapshot.phase} (${snapshot.replicas.onSpec}/${snapshot.replicas.total} replicas on the new spec)${snapshot.reason ? ` - ${snapshot.reason}` : ''}`;
        },
    };
}
