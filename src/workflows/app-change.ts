/**
 * Application change workflow
 * One plan and one PATCH for every change to an existing CloudHub 2.0 application: artifact,
 * runtime, settings and update strategy, applied in place or as stop, change, start. Shared by
 * the MCP tools and the CLI so previews, runtime checks, secret handling and waits match.
 */

import type { AnypointClient } from '../client/AnypointClient.js';
import type { Environment } from '../api/AccessManagementApi.js';
import type { ArtifactRef, CH2Deployment, DeploymentPatch } from '../api/CloudHub2Api.js';
import type { RuntimeVersion } from '../api/RuntimesApi.js';
import {
    isEmptySettingsChange,
    mergeForArtifactUpdate,
    planSettingsChange,
    type DeploymentChange,
    type SettingsChange,
    type SettingsPlan,
} from '../safety/deployment.js';
import { checkBuildProvenance, type BuildProvenance, type ProvenanceCheck } from '../safety/artifact.js';
import { isProductionEnv } from '../safety/guards.js';
import { parseRuntimeString, resolveRuntime, suggestRuntimes, type RuntimeSpec } from '../safety/runtime.js';
import { looksSecret, redactText } from '../safety/secrets.js';
import { resolveSecretSources, type SecretSource } from '../safety/secret-sources.js';
import { errorMessage } from '../utils/errors.js';
import { deploymentPhase, waitForAppPhase, type PhaseSnapshot, type WaitResult } from './app-state.js';

export type ChangeMode = 'inPlace' | 'stopStart';
export type UpdateStrategy = 'rolling' | 'recreate';

/** A settings change as callers express it: inline values plus server-side sources. */
export interface SettingsChangeInput extends SettingsChange {
    propertiesFrom?: SecretSource[];
    securePropertiesFrom?: SecretSource[];
}

/** Resolve file and environment sources into values. Returns the secret values for output scrubbing. */
export function resolveSettingsInput(
    input: SettingsChangeInput | undefined,
    options: { projectRoot?: string; env?: NodeJS.ProcessEnv } = {},
): { change: SettingsChange | undefined; secretValues: string[] } {
    if (!input) return { change: undefined, secretValues: [] };
    const properties = { ...resolveSecretSources(input.propertiesFrom, options), ...(input.properties ?? {}) };
    const secureProperties = {
        ...resolveSecretSources(input.securePropertiesFrom, options),
        ...(input.secureProperties ?? {}),
    };
    const change: SettingsChange = {
        ...(Object.keys(properties).length ? { properties } : {}),
        ...(Object.keys(secureProperties).length ? { secureProperties } : {}),
        ...(input.removeProperties?.length ? { removeProperties: input.removeProperties } : {}),
        ...(input.removeSecureProperties?.length ? { removeSecureProperties: input.removeSecureProperties } : {}),
        ...(input.moveToSecure?.length ? { moveToSecure: input.moveToSecure } : {}),
    };
    const secretValues = [
        ...Object.values(secureProperties),
        ...Object.entries(properties)
            .filter(([key]) => looksSecret(key))
            .map(([, value]) => value),
    ];
    return { change: isEmptySettingsChange(change) ? undefined : change, secretValues };
}

export interface AppChangeRequest {
    orgId: string;
    env: Environment;
    appName: string;
    /** Prefetched deployment detail; looked up by name when omitted. */
    existing?: CH2Deployment | null;
    ref?: Partial<ArtifactRef>;
    runtime?: RuntimeSpec;
    settings?: SettingsChange;
    updateStrategy?: UpdateStrategy;
    mode?: ChangeMode;
    /** Restart even when nothing else changes (stop then start). */
    restart?: boolean;
    /** Build marker of the local jar the new artifact was published from; checked against the environment. */
    buildProvenance?: BuildProvenance;
    /** Values to scrub from every response and error. */
    secretValues?: string[];
}

export interface RuntimeCheck {
    checked: boolean;
    reason?: string;
    targetId: string;
    current: { version: string; java?: string; releaseChannel?: string; supported?: boolean };
    requested?: { version: string; java?: string; releaseChannel?: string; supported?: boolean };
    suggestions?: string[];
}

export interface AppChangePlan {
    request: AppChangeRequest;
    existing: CH2Deployment;
    mode: ChangeMode;
    patch: DeploymentPatch;
    changes: DeploymentChange[];
    settings?: SettingsPlan;
    runtimeCheck: RuntimeCheck;
    steps: string[];
    warnings: string[];
    /** Problems that stop the change before anything is written. */
    blockers: string[];
    production: boolean;
    /** Present when the request carried a local jar's build marker. */
    provenance?: ProvenanceCheck;
    /** Nothing would change. */
    noop: boolean;
}

function refsDiffer(a: ArtifactRef, b: ArtifactRef): boolean {
    return (
        a.groupId !== b.groupId ||
        a.artifactId !== b.artifactId ||
        a.version !== b.version ||
        a.packaging !== b.packaging
    );
}

async function loadCatalog(
    client: AnypointClient,
    orgId: string,
    targetId: string,
): Promise<{ catalog?: RuntimeVersion[]; reason?: string }> {
    try {
        const target = await client.runtimes.getTarget(orgId, targetId);
        if (!target) return { reason: `target ${targetId} is not in the organization's runtime catalog` };
        if (target.runtimes.length === 0) return { reason: `target ${targetId} lists no runtime versions` };
        return { catalog: target.runtimes };
    } catch (error) {
        return { reason: `runtime catalog unavailable: ${errorMessage(error)}` };
    }
}

/** Pick the Java version to send: requested, else the current one if still offered, else 17, else the newest offered. */
function chooseJava(resolved: RuntimeVersion | undefined, requested?: string, current?: string): string | undefined {
    if (requested) return requested;
    if (!resolved || resolved.java.length === 0) return current;
    if (current && resolved.java.includes(current)) return current;
    if (resolved.java.includes('17')) return '17';
    return resolved.java[resolved.java.length - 1];
}

/** Build the plan: what changes, the single PATCH body, the runtime check and the steps. Nothing is written. */
export async function planAppChange(client: AnypointClient, request: AppChangeRequest): Promise<AppChangePlan> {
    const existing =
        request.existing ?? (await client.cloudHub2.findDetailByName(request.orgId, request.env.id, request.appName));
    if (!existing) throw new Error(`Application "${request.appName}" not found in ${request.env.name}`);

    const mode: ChangeMode = request.mode ?? (request.restart ? 'stopStart' : 'inPlace');
    const changes: DeploymentChange[] = [];
    const warnings: string[] = [];
    const blockers: string[] = [];
    const patch: DeploymentPatch = {};
    const settings = existing.target?.deploymentSettings ?? {};

    // Artifact
    if (request.ref && Object.values(request.ref).some((v) => v !== undefined)) {
        const nextRef = mergeForArtifactUpdate(existing, request.ref).application.ref;
        if (refsDiffer(existing.application.ref, nextRef)) {
            patch.application = { ...patch.application, ref: nextRef };
            for (const field of ['groupId', 'artifactId', 'version', 'packaging'] as const) {
                if (existing.application.ref[field] !== nextRef[field]) {
                    changes.push({ field: `ref.${field}`, from: existing.application.ref[field], to: nextRef[field] });
                }
            }
        }
    }

    // Settings
    let settingsPlan: SettingsPlan | undefined;
    if (!isEmptySettingsChange(request.settings)) {
        settingsPlan = planSettingsChange(existing, request.settings as SettingsChange);
        warnings.push(...settingsPlan.warnings);
        if (settingsPlan.changed) {
            patch.application = {
                ...patch.application,
                configuration: { 'mule.agent.application.properties.service': settingsPlan.service },
            };
        }
    }

    // Runtime
    const currentRuntime = settings.runtime ?? { version: 'unknown' };
    const current = parseRuntimeString(currentRuntime.version, currentRuntime.java);
    const { catalog, reason } = await loadCatalog(client, request.orgId, existing.target.targetId);
    const runtimeCheck: RuntimeCheck = {
        checked: Boolean(catalog),
        ...(reason ? { reason } : {}),
        targetId: existing.target.targetId,
        current: {
            version: current.version,
            ...(current.java ? { java: current.java } : {}),
            ...(currentRuntime.releaseChannel ? { releaseChannel: currentRuntime.releaseChannel } : {}),
            ...(catalog
                ? { supported: Boolean(resolveRuntime(catalog, { version: current.version, java: current.java })) }
                : {}),
        },
    };

    let nextRuntime: { version: string; releaseChannel?: string; java?: string } | undefined;
    if (request.runtime) {
        const resolved = catalog ? resolveRuntime(catalog, request.runtime) : undefined;
        runtimeCheck.requested = {
            version: request.runtime.version,
            ...(request.runtime.java ? { java: request.runtime.java } : {}),
            ...(request.runtime.releaseChannel ? { releaseChannel: request.runtime.releaseChannel } : {}),
            ...(catalog ? { supported: Boolean(resolved) } : {}),
        };
        if (catalog && !resolved) {
            runtimeCheck.suggestions = suggestRuntimes(
                catalog,
                request.runtime.java ? request.runtime : { ...request.runtime, java: current.java },
            );
            blockers.push(
                `Runtime ${request.runtime.version}${request.runtime.java ? ` (Java ${request.runtime.java})` : ''} is not offered by ${existing.target.targetId}. Nearest supported: ${runtimeCheck.suggestions.join('; ') || 'none listed'}`,
            );
        }
        nextRuntime = {
            version: resolved?.version ?? request.runtime.version,
            ...((request.runtime.releaseChannel ?? resolved?.releaseChannel ?? currentRuntime.releaseChannel)
                ? {
                      releaseChannel:
                          request.runtime.releaseChannel ?? resolved?.releaseChannel ?? currentRuntime.releaseChannel,
                  }
                : {}),
            ...(chooseJava(resolved, request.runtime.java, current.java)
                ? { java: chooseJava(resolved, request.runtime.java, current.java) }
                : {}),
        };
        if (!catalog) warnings.push(`Runtime ${nextRuntime.version} was not validated (${reason})`);
        if (nextRuntime.version !== current.version)
            changes.push({ field: 'runtime', from: current.version, to: nextRuntime.version });
        if (nextRuntime.java && nextRuntime.java !== current.java)
            changes.push({ field: 'java', from: current.java, to: nextRuntime.java });
        if (nextRuntime.releaseChannel && nextRuntime.releaseChannel !== currentRuntime.releaseChannel) {
            changes.push({
                field: 'releaseChannel',
                from: currentRuntime.releaseChannel,
                to: nextRuntime.releaseChannel,
            });
        }
        if (changes.every((c) => !['runtime', 'java', 'releaseChannel'].includes(c.field))) nextRuntime = undefined;
    }

    // Update strategy
    const strategyChange =
        request.updateStrategy && request.updateStrategy !== (settings.updateStrategy ?? 'rolling')
            ? request.updateStrategy
            : undefined;
    if (strategyChange)
        changes.push({ field: 'updateStrategy', from: settings.updateStrategy ?? 'rolling', to: strategyChange });

    if (nextRuntime || strategyChange) {
        // The live target is restated exactly as read, so only the runtime and strategy differ.
        patch.target = {
            provider: existing.target.provider,
            targetId: existing.target.targetId,
            replicas: existing.target.replicas,
            deploymentSettings: {
                ...settings,
                ...(nextRuntime ? { runtime: nextRuntime } : {}),
                ...(strategyChange ? { updateStrategy: strategyChange } : {}),
            },
        };
    }

    const createsSpec = Boolean(patch.application?.ref || patch.application?.configuration || patch.target);
    if (catalog && runtimeCheck.current.supported === false && !nextRuntime && createsSpec) {
        runtimeCheck.suggestions = suggestRuntimes(catalog, current);
        blockers.push(
            `The app's current runtime ${current.version}${current.java ? ` (Java ${current.java})` : ''} is no longer offered by ${existing.target.targetId}, so the platform will reject a new spec. Pass runtime with one of: ${runtimeCheck.suggestions.join('; ') || 'none listed'}`,
        );
    }

    const noop = !createsSpec && !request.restart;
    if (mode === 'stopStart' && !noop) patch.application = { ...patch.application, desiredState: 'STARTED' };

    if (settingsPlan?.changed) warnings.push('Applying a settings change restarts the application.');
    if (mode === 'inPlace' && createsSpec && (settings.updateStrategy ?? 'rolling') === 'rolling' && !strategyChange) {
        warnings.push(
            'Rolling update: old and new replicas overlap briefly. For apps with streaming or polling listeners use mode stopStart, or set updateStrategy recreate.',
        );
    }
    if (mode === 'inPlace' && existing.application.desiredState === 'STOPPED' && createsSpec) {
        warnings.push('The application is stopped; the change applies but it stays stopped until started.');
    }

    const production = isProductionEnv(request.env.name, request.env.isProduction);
    const provenance = request.buildProvenance ? checkBuildProvenance(request.buildProvenance, production) : undefined;
    if (provenance) {
        warnings.push(...provenance.warnings);
        if (provenance.blocker) blockers.push(provenance.blocker);
    }

    const steps = noop
        ? []
        : mode === 'stopStart'
          ? [
                ...(existing.application.desiredState !== 'STOPPED'
                    ? ['stop the application and wait until it is stopped']
                    : []),
                createsSpec ? 'apply the change and start in one update' : 'start the application',
                'wait until every replica runs the new spec',
            ]
          : ['apply the change in one update (one new spec)', 'wait until every replica runs the new spec'];

    return {
        request,
        existing,
        mode,
        patch,
        changes,
        ...(settingsPlan ? { settings: settingsPlan } : {}),
        runtimeCheck,
        steps,
        warnings,
        blockers,
        production,
        ...(provenance ? { provenance } : {}),
        noop,
    };
}

/** A serializable preview of the plan. Never contains secret values. */
export function describeAppChange(plan: AppChangePlan) {
    const { existing, request } = plan;
    const preview = {
        app: existing.name,
        environment: request.env.name,
        mode: plan.mode,
        current: {
            ref: existing.application.ref,
            runtime: existing.target?.deploymentSettings?.runtime,
            updateStrategy: existing.target?.deploymentSettings?.updateStrategy ?? 'rolling',
            desiredState: existing.application.desiredState,
            phase: deploymentPhase(existing).phase,
        },
        changes: plan.changes,
        ...(plan.settings ? { settings: plan.settings.diff } : {}),
        runtimeCheck: plan.runtimeCheck,
        ...(plan.provenance ? { buildProvenance: plan.provenance.buildProvenance } : {}),
        steps: plan.steps,
        ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
        ...(plan.blockers.length ? { blockers: plan.blockers } : {}),
        ...(plan.noop ? { noop: true } : {}),
        ...(plan.production ? { production: true } : {}),
        preserved: 'target, replicas, resources, other settings and stored secure values',
    };
    return JSON.parse(redactText(JSON.stringify(preview), request.secretValues ?? [])) as typeof preview;
}

export interface AppChangeResult {
    deployment: CH2Deployment;
    performed: string[];
    snapshot?: PhaseSnapshot;
    timedOut?: boolean;
    /** The stop step ran but the start step did not; the app is left stopped. */
    leftStopped?: boolean;
}

export interface ExecuteOptions {
    wait?: boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
    graceMs?: number;
    onStatus?: (step: string, snapshot: PhaseSnapshot) => void;
}

/** Apply a plan. Errors and results are scrubbed of the request's secret values. */
export async function executeAppChange(
    client: AnypointClient,
    plan: AppChangePlan,
    options: ExecuteOptions = {},
): Promise<AppChangeResult> {
    if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
    const { orgId, env, secretValues = [] } = plan.request;
    const { existing } = plan;
    const performed: string[] = [];
    if (plan.noop) return { deployment: existing, performed };

    // `previous` enables the staleness check, needed only when the target state looks like the
    // starting state (an in-place update of a running app). Stop and start are told apart by state.
    const waitFor = (
        step: string,
        previous: CH2Deployment | undefined,
        sentAt: number,
        expectedSpecVersion?: string,
    ): Promise<WaitResult> =>
        waitForAppPhase(client.cloudHub2, orgId, env.id, existing.id, {
            expectedSpecVersion,
            previousModifiedDate: previous?.lastModifiedDate,
            sinceChange: sentAt,
            timeoutMs: options.timeoutMs,
            pollIntervalMs: options.pollIntervalMs,
            graceMs: options.graceMs,
            onStatus: options.onStatus ? (snapshot) => options.onStatus?.(step, snapshot) : undefined,
        });

    try {
        let before = existing;
        if (plan.mode === 'stopStart' && existing.application.desiredState !== 'STOPPED') {
            const sentAt = Date.now();
            await client.cloudHub2.setDesiredState(orgId, env.id, existing.id, 'STOPPED');
            performed.push('stop requested');
            const stopped = await waitFor('stop', undefined, sentAt);
            if (!stopped.snapshot.settled) {
                throw new Error(
                    `Stop did not complete (${stopped.snapshot.phase}${stopped.timedOut ? ', timed out' : ''}); the change was not applied. The app may still be stopping.`,
                );
            }
            performed.push('stopped');
            before = stopped.deployment;
        }

        const sentAt = Date.now();
        const deployment = await client.cloudHub2.patchDeployment(orgId, env.id, existing.id, plan.patch);
        performed.push(plan.mode === 'stopStart' ? 'change applied and start requested' : 'change applied');

        if (!options.wait) return { deployment, performed };
        const expected =
            deployment.desiredVersion && deployment.desiredVersion !== before.desiredVersion
                ? deployment.desiredVersion
                : undefined;
        const wasRunning = before.application.desiredState !== 'STOPPED';
        const result = await waitFor('apply', wasRunning ? before : undefined, sentAt, expected);
        performed.push(result.snapshot.settled ? 'settled' : `wait ended in ${result.snapshot.phase}`);
        return { deployment: result.deployment, performed, snapshot: result.snapshot, timedOut: result.timedOut };
    } catch (error) {
        const leftStopped =
            performed.includes('stopped') && !performed.some((step) => step.startsWith('change applied'));
        const message = redactText(errorMessage(error), secretValues);
        const err = new Error(
            leftStopped
                ? `${message}\nThe application was stopped and is still stopped. Steps done: ${performed.join(', ')}`
                : performed.length
                  ? `${message}\nSteps done: ${performed.join(', ')}`
                  : message,
        );
        throw err;
    }
}
