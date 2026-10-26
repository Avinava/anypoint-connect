/**
 * Deployment state model
 * One interpretation of CloudHub 2.0 deployment, application and replica status, shared by
 * status reads and every wait loop. It hides the transient FAILED the platform reports while
 * a stopped app starts, and never treats a status left over from the previous spec as settled.
 */

import type { CH2Deployment } from '../api/CloudHub2Api.js';

/** The slice of the CloudHub 2.0 API the wait loop needs. */
export interface DeploymentReader {
    getDeployment(orgId: string, envId: string, deploymentId: string): Promise<CH2Deployment>;
}

export interface WaitOptions extends PhaseOptions {
    timeoutMs?: number;
    pollIntervalMs?: number;
    onStatus?: (snapshot: PhaseSnapshot, deployment: CH2Deployment) => void;
}

export interface WaitResult {
    deployment: CH2Deployment;
    snapshot: PhaseSnapshot;
    timedOut: boolean;
    waitedMs: number;
}

/**
 * Poll until the deployment is terminal (settled, failed past the grace window, or degraded)
 * or the timeout passes. Never throws for a failed deployment; the caller reads the snapshot.
 */
export async function waitForAppPhase(
    api: DeploymentReader,
    orgId: string,
    envId: string,
    deploymentId: string,
    options: WaitOptions = {},
): Promise<WaitResult> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const phaseOptions: PhaseOptions = {
        expectedSpecVersion: options.expectedSpecVersion,
        previousModifiedDate: options.previousModifiedDate,
        sinceChange: options.sinceChange ?? startedAt,
        graceMs: options.graceMs,
    };

    while (true) {
        const deployment = await api.getDeployment(orgId, envId, deploymentId);
        const snapshot = deploymentPhase(deployment, phaseOptions);
        options.onStatus?.(snapshot, deployment);
        const waitedMs = Date.now() - startedAt;
        if (snapshot.terminal) return { deployment, snapshot, timedOut: false, waitedMs };
        if (waitedMs >= timeoutMs) return { deployment, snapshot, timedOut: true, waitedMs };
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}

export type AppPhase = 'RUNNING' | 'STARTING' | 'UPDATING' | 'DEGRADED' | 'FAILED' | 'STOPPING' | 'STOPPED';

export interface PhaseSnapshot {
    phase: AppPhase;
    /** The app reached its desired state on the expected spec. */
    settled: boolean;
    /** Waiting longer will not change the outcome (settled, failed or degraded past the grace window). */
    terminal: boolean;
    reason?: string;
    desiredState: string;
    platformStatus: string;
    replicas: { total: number; started: number; onSpec: number; failed: number };
    specVersion?: string;
}

export interface PhaseOptions {
    /** Spec version the change produced; replicas must run it to count as settled. */
    expectedSpecVersion?: string;
    /** The deployment's `lastModifiedDate` before the change; an unchanged value means the change is not visible yet. */
    previousModifiedDate?: number;
    /** When the change was sent (local epoch ms), the start of the grace window. Defaults to the deployment's last modification. */
    sinceChange?: number;
    /** How long a FAILED status is treated as start-up noise. Default 90 s. */
    graceMs?: number;
    now?: number;
}

export const DEFAULT_GRACE_MS = 90_000;

const STOPPED_REPLICA_STATES = new Set(['STOPPED', 'TERMINATED', 'DELETED']);
const FAILED_PLATFORM_STATUSES = new Set(['FAILED', 'DEPLOYMENT_FAILED']);

/** Interpret a deployment detail as a single phase. Pure; safe to call on every poll. */
export function deploymentPhase(deployment: CH2Deployment, options: PhaseOptions = {}): PhaseSnapshot {
    const now = options.now ?? Date.now();
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const since = options.sinceChange ?? deployment.lastModifiedDate ?? 0;
    const withinGrace = now - since < graceMs;
    const desiredState = deployment.application?.desiredState ?? 'STARTED';
    const platformStatus = deployment.status;
    const replicas = deployment.replicas ?? [];
    const specVersion = options.expectedSpecVersion ?? deployment.desiredVersion;

    const onSpec = (version?: string) => !specVersion || version === specVersion;
    const started = replicas.filter((r) => r.state === 'STARTED');
    const startedOnSpec = started.filter((r) => onSpec(r.currentDeploymentVersion));
    const failed = replicas.filter((r) => r.state === 'FAILED');
    const counts = {
        total: replicas.length,
        started: started.length,
        onSpec: startedOnSpec.length,
        failed: failed.length,
    };
    const base = { desiredState, platformStatus, replicas: counts, specVersion };
    const failureReason = failed.find((r) => r.reason)?.reason;

    // A change sent after the deployment's last modification has not been picked up yet.
    // Compared against the server's own earlier timestamp, so local clock skew cannot matter.
    const stale =
        options.previousModifiedDate !== undefined &&
        !options.expectedSpecVersion &&
        (deployment.lastModifiedDate ?? 0) <= options.previousModifiedDate;

    if (desiredState === 'STOPPED') {
        const down = replicas.every((r) => STOPPED_REPLICA_STATES.has(r.state));
        if (down && !stale && platformStatus !== 'APPLYING') {
            return { ...base, phase: 'STOPPED', settled: true, terminal: true };
        }
        return { ...base, phase: 'STOPPING', settled: false, terminal: false };
    }

    const expected = deployment.target?.replicas ?? replicas.length;
    // With autoscaling the replica count floats, so only an exact count is required without it.
    const autoscaled = deployment.target?.deploymentSettings?.autoscaling?.enabled === true;
    const countOk = autoscaled ? replicas.length > 0 : replicas.length === expected;
    const allOnSpec = replicas.length > 0 && startedOnSpec.length === replicas.length && countOk;
    if (!stale && platformStatus === 'APPLIED' && allOnSpec) {
        return { ...base, phase: 'RUNNING', settled: true, terminal: true };
    }

    const platformFailed = FAILED_PLATFORM_STATUSES.has(platformStatus);
    // Replica failure reasons also appear during normal start-up, so only time confirms a failure.
    if ((platformFailed || failed.length > 0) && !withinGrace) {
        const reason = failureReason ?? `Platform reports ${platformStatus}`;
        if (startedOnSpec.length > 0) return { ...base, phase: 'DEGRADED', settled: false, terminal: true, reason };
        return { ...base, phase: 'FAILED', settled: false, terminal: true, reason };
    }

    const transitional =
        platformFailed || failed.length > 0 ? 'replicas still starting; failure not yet confirmed' : undefined;
    if (started.length > 0 && startedOnSpec.length < started.length) {
        return { ...base, phase: 'UPDATING', settled: false, terminal: false, reason: transitional ?? failureReason };
    }
    if (startedOnSpec.length > 0 && !allOnSpec) {
        return { ...base, phase: 'UPDATING', settled: false, terminal: false, reason: transitional ?? failureReason };
    }
    return { ...base, phase: 'STARTING', settled: false, terminal: false, reason: transitional ?? failureReason };
}
