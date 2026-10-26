import { describe, expect, it, vi } from 'vitest';
import type { CH2Deployment, CH2Replica } from '../../src/api/CloudHub2Api.js';
import { DEFAULT_GRACE_MS, deploymentPhase, waitForAppPhase } from '../../src/workflows/app-state.js';

const CHANGE_AT = 1_700_000_000_000;
const WITHIN_GRACE = CHANGE_AT + 30_000;
const PAST_GRACE = CHANGE_AT + DEFAULT_GRACE_MS + 1;

function makeDeployment(
    overrides: {
        status?: string;
        desiredState?: string;
        replicas?: CH2Replica[];
        targetReplicas?: number;
        desiredVersion?: string;
        lastModifiedDate?: number;
    } = {},
): CH2Deployment {
    const replicas = overrides.replicas ?? [{ id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' }];
    return {
        id: 'dep-1',
        name: 'orders-sapi',
        status: overrides.status ?? 'APPLIED',
        application: {
            ref: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' },
            desiredState: overrides.desiredState ?? 'STARTED',
        },
        target: {
            provider: 'MC',
            targetId: 'cloudhub-us-east-2',
            deploymentSettings: { runtime: { version: '4.9.0' } },
            replicas: overrides.targetReplicas ?? replicas.length,
        },
        replicas,
        desiredVersion: overrides.desiredVersion ?? 'spec-2',
        lastModifiedDate: overrides.lastModifiedDate ?? CHANGE_AT,
    };
}

describe('deploymentPhase', () => {
    it('reports RUNNING and settled when every replica runs the desired spec', () => {
        const snapshot = deploymentPhase(makeDeployment(), { now: PAST_GRACE, sinceChange: CHANGE_AT });
        expect(snapshot).toMatchObject({ phase: 'RUNNING', settled: true, terminal: true, platformStatus: 'APPLIED' });
        expect(snapshot.replicas).toEqual({ total: 1, started: 1, onSpec: 1, failed: 0 });
    });

    describe('start-up grace', () => {
        const starting = makeDeployment({ status: 'FAILED', replicas: [{ id: 'r1', state: 'FAILED' }] });

        it('reports a FAILED/FAILED start inside the grace window as STARTING', () => {
            const snapshot = deploymentPhase(starting, { now: WITHIN_GRACE, sinceChange: CHANGE_AT });
            expect(snapshot).toMatchObject({ phase: 'STARTING', settled: false, terminal: false });
            expect(snapshot.reason).toBe('replicas still starting; failure not yet confirmed');
        });

        it('reports FAILED once the grace window passes', () => {
            const snapshot = deploymentPhase(starting, { now: PAST_GRACE, sinceChange: CHANGE_AT });
            expect(snapshot).toMatchObject({ phase: 'FAILED', settled: false, terminal: true });
            expect(snapshot.reason).toBe('Platform reports FAILED');
        });

        it('treats a pending replica with a FAILED platform status the same way', () => {
            const pending = makeDeployment({ status: 'FAILED', replicas: [{ id: 'r1', state: 'PENDING' }] });
            expect(deploymentPhase(pending, { now: WITHIN_GRACE, sinceChange: CHANGE_AT }).phase).toBe('STARTING');
            expect(deploymentPhase(pending, { now: PAST_GRACE, sinceChange: CHANGE_AT }).phase).toBe('FAILED');
        });

        it('honors a custom grace window', () => {
            const snapshot = deploymentPhase(starting, { now: WITHIN_GRACE, sinceChange: CHANGE_AT, graceMs: 10_000 });
            expect(snapshot.phase).toBe('FAILED');
        });

        it('defaults the start of the grace window to the last modification', () => {
            expect(deploymentPhase(starting, { now: WITHIN_GRACE }).phase).toBe('STARTING');
            expect(deploymentPhase(starting, { now: PAST_GRACE }).phase).toBe('FAILED');
        });
    });

    it('reports FAILED with the replica failure reason past the grace window', () => {
        const deployment = makeDeployment({
            status: 'APPLYING',
            replicas: [{ id: 'r1', state: 'FAILED', reason: 'Application failed to start: port in use' }],
        });
        const snapshot = deploymentPhase(deployment, { now: PAST_GRACE, sinceChange: CHANGE_AT });
        expect(snapshot).toMatchObject({
            phase: 'FAILED',
            terminal: true,
            reason: 'Application failed to start: port in use',
        });
        expect(snapshot.replicas.failed).toBe(1);
    });

    it('does not settle on a stale APPLIED left over from the previous spec', () => {
        const deployment = makeDeployment({ lastModifiedDate: CHANGE_AT });
        const snapshot = deploymentPhase(deployment, {
            now: WITHIN_GRACE,
            sinceChange: CHANGE_AT,
            previousModifiedDate: CHANGE_AT,
        });
        expect(snapshot.settled).toBe(false);
        expect(snapshot.terminal).toBe(false);
        expect(snapshot.phase).not.toBe('RUNNING');

        const moved = makeDeployment({ lastModifiedDate: CHANGE_AT + 1 });
        expect(
            deploymentPhase(moved, { now: WITHIN_GRACE, sinceChange: CHANGE_AT, previousModifiedDate: CHANGE_AT }),
        ).toMatchObject({ phase: 'RUNNING', settled: true });
    });

    describe('expectedSpecVersion', () => {
        it('reports UPDATING while replicas run the old spec', () => {
            const deployment = makeDeployment({
                replicas: [
                    { id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-1' },
                    { id: 'r2', state: 'STARTED', currentDeploymentVersion: 'spec-1' },
                ],
            });
            const snapshot = deploymentPhase(deployment, {
                now: WITHIN_GRACE,
                sinceChange: CHANGE_AT,
                expectedSpecVersion: 'spec-2',
            });
            expect(snapshot).toMatchObject({
                phase: 'UPDATING',
                settled: false,
                terminal: false,
                specVersion: 'spec-2',
            });
            expect(snapshot.replicas).toMatchObject({ started: 2, onSpec: 0 });
        });

        it('reports UPDATING while only some replicas run the new spec', () => {
            const deployment = makeDeployment({
                replicas: [
                    { id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                    { id: 'r2', state: 'STARTED', currentDeploymentVersion: 'spec-1' },
                ],
            });
            expect(
                deploymentPhase(deployment, {
                    now: WITHIN_GRACE,
                    sinceChange: CHANGE_AT,
                    expectedSpecVersion: 'spec-2',
                }).phase,
            ).toBe('UPDATING');
        });

        it('reports RUNNING and settled once every replica runs the new spec', () => {
            const deployment = makeDeployment({
                replicas: [
                    { id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                    { id: 'r2', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                ],
                lastModifiedDate: CHANGE_AT,
            });
            // previousModifiedDate is ignored once the expected spec is known.
            const snapshot = deploymentPhase(deployment, {
                now: WITHIN_GRACE,
                sinceChange: CHANGE_AT,
                expectedSpecVersion: 'spec-2',
                previousModifiedDate: CHANGE_AT,
            });
            expect(snapshot).toMatchObject({ phase: 'RUNNING', settled: true, terminal: true });
        });

        it('does not settle with fewer replicas than the target asks for', () => {
            const deployment = makeDeployment({
                targetReplicas: 2,
                replicas: [{ id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' }],
            });
            const snapshot = deploymentPhase(deployment, { now: WITHIN_GRACE, expectedSpecVersion: 'spec-2' });
            expect(snapshot).toMatchObject({ phase: 'UPDATING', settled: false });
        });

        it('does not settle with more replicas than the target asks for (old generation still draining)', () => {
            const deployment = makeDeployment({
                targetReplicas: 1,
                replicas: [
                    { id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                    { id: 'r2', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                ],
            });
            const snapshot = deploymentPhase(deployment, { now: WITHIN_GRACE, expectedSpecVersion: 'spec-2' });
            expect(snapshot).toMatchObject({ phase: 'UPDATING', settled: false, terminal: false });
        });

        it('only needs one replica on spec when autoscaling is enabled', () => {
            const base = makeDeployment({
                targetReplicas: 1,
                replicas: [
                    { id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                    { id: 'r2', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                    { id: 'r3', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                ],
            });
            const autoscaled: CH2Deployment = {
                ...base,
                target: {
                    ...base.target,
                    deploymentSettings: {
                        ...base.target.deploymentSettings,
                        autoscaling: { enabled: true, minReplicas: 1, maxReplicas: 3 },
                    },
                },
            };
            expect(deploymentPhase(autoscaled, { now: WITHIN_GRACE, expectedSpecVersion: 'spec-2' })).toMatchObject({
                phase: 'RUNNING',
                settled: true,
            });

            const fewer: CH2Deployment = {
                ...autoscaled,
                target: { ...autoscaled.target, replicas: 3 },
                replicas: [{ id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' }],
            };
            expect(deploymentPhase(fewer, { now: WITHIN_GRACE, expectedSpecVersion: 'spec-2' }).settled).toBe(true);

            const none: CH2Deployment = { ...autoscaled, replicas: [] };
            expect(deploymentPhase(none, { now: WITHIN_GRACE, expectedSpecVersion: 'spec-2' }).settled).toBe(false);
        });
    });

    describe('stopping', () => {
        it('reports STOPPING while replicas are still up', () => {
            const deployment = makeDeployment({ desiredState: 'STOPPED', status: 'APPLYING' });
            expect(deploymentPhase(deployment, { now: WITHIN_GRACE })).toMatchObject({
                phase: 'STOPPING',
                settled: false,
                terminal: false,
                desiredState: 'STOPPED',
            });
        });

        it('reports STOPPED once every replica is down', () => {
            const deployment = makeDeployment({
                desiredState: 'STOPPED',
                status: 'APPLIED',
                replicas: [{ id: 'r1', state: 'STOPPED' }],
                lastModifiedDate: CHANGE_AT + 5,
            });
            expect(deploymentPhase(deployment, { now: WITHIN_GRACE, previousModifiedDate: CHANGE_AT })).toMatchObject({
                phase: 'STOPPED',
                settled: true,
                terminal: true,
            });
            expect(deploymentPhase(makeDeployment({ desiredState: 'STOPPED', replicas: [] })).phase).toBe('STOPPED');
        });

        it('keeps STOPPING while the platform is still applying or the stop is not visible yet', () => {
            const down = { desiredState: 'STOPPED', replicas: [{ id: 'r1', state: 'TERMINATED' }] };
            expect(deploymentPhase(makeDeployment({ ...down, status: 'APPLYING' })).phase).toBe('STOPPING');
            expect(
                deploymentPhase(makeDeployment({ ...down, lastModifiedDate: CHANGE_AT }), {
                    previousModifiedDate: CHANGE_AT,
                }).phase,
            ).toBe('STOPPING');
        });
    });

    describe('degraded', () => {
        const mixed = makeDeployment({
            status: 'APPLYING',
            replicas: [
                { id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' },
                { id: 'r2', state: 'FAILED', currentDeploymentVersion: 'spec-2', reason: 'Readiness probe failed' },
            ],
        });

        it('reports DEGRADED when some replicas started and others failed past the grace window', () => {
            expect(deploymentPhase(mixed, { now: PAST_GRACE, sinceChange: CHANGE_AT })).toMatchObject({
                phase: 'DEGRADED',
                settled: false,
                terminal: true,
                reason: 'Readiness probe failed',
            });
        });

        it('keeps waiting inside the grace window', () => {
            expect(deploymentPhase(mixed, { now: WITHIN_GRACE, sinceChange: CHANGE_AT })).toMatchObject({
                phase: 'UPDATING',
                terminal: false,
                reason: 'replicas still starting; failure not yet confirmed',
            });
        });
    });
});

describe('waitForAppPhase', () => {
    const startingDeployment = makeDeployment({ status: 'APPLYING', replicas: [{ id: 'r1', state: 'PENDING' }] });
    const runningDeployment = makeDeployment();

    it('polls until the deployment reaches a terminal phase', async () => {
        const reader = {
            getDeployment: vi
                .fn()
                .mockResolvedValueOnce(startingDeployment)
                .mockResolvedValueOnce(startingDeployment)
                .mockResolvedValue(runningDeployment),
        };
        const onStatus = vi.fn();
        const result = await waitForAppPhase(reader, 'org-1', 'env-1', 'dep-1', {
            pollIntervalMs: 0,
            expectedSpecVersion: 'spec-2',
            onStatus,
        });

        expect(reader.getDeployment).toHaveBeenCalledTimes(3);
        expect(reader.getDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1');
        expect(onStatus.mock.calls.map(([snapshot]) => snapshot.phase)).toEqual(['STARTING', 'STARTING', 'RUNNING']);
        expect(result).toMatchObject({ timedOut: false, deployment: runningDeployment });
        expect(result.snapshot).toMatchObject({ phase: 'RUNNING', settled: true });
    });

    it('returns the last snapshot with timedOut when the timeout passes', async () => {
        const reader = { getDeployment: vi.fn().mockResolvedValue(startingDeployment) };
        const result = await waitForAppPhase(reader, 'org-1', 'env-1', 'dep-1', { pollIntervalMs: 0, timeoutMs: 5 });

        expect(result.timedOut).toBe(true);
        expect(result.snapshot).toMatchObject({ phase: 'STARTING', settled: false });
        expect(reader.getDeployment).toHaveBeenCalled();
    });

    it('returns a failure as a snapshot instead of throwing', async () => {
        const failed = makeDeployment({
            status: 'FAILED',
            replicas: [{ id: 'r1', state: 'FAILED', reason: 'crash' }],
            lastModifiedDate: CHANGE_AT,
        });
        const reader = { getDeployment: vi.fn().mockResolvedValue(failed) };
        const result = await waitForAppPhase(reader, 'org-1', 'env-1', 'dep-1', {
            pollIntervalMs: 0,
            sinceChange: CHANGE_AT,
        });
        expect(result.timedOut).toBe(false);
        expect(result.snapshot).toMatchObject({ phase: 'FAILED', reason: 'crash' });
    });
});
