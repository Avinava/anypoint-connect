import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CH2Deployment } from '../../src/api/CloudHub2Api.js';
import type { RuntimeVersion } from '../../src/api/RuntimesApi.js';
import { MASKED } from '../../src/safety/secrets.js';
import {
    describeAppChange,
    executeAppChange,
    planAppChange,
    resolveSettingsInput,
    type AppChangeRequest,
} from '../../src/workflows/app-change.js';

const SECRET = 'sample-secret-value-123';
const SERVICE = 'mule.agent.application.properties.service';

function makeExisting(
    overrides: { runtime?: { version: string; java?: string; releaseChannel?: string }; desiredState?: string } = {},
): CH2Deployment {
    return {
        id: 'dep-1',
        name: 'orders-sapi',
        status: 'APPLIED',
        application: {
            ref: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' },
            desiredState: overrides.desiredState ?? 'STARTED',
            configuration: {
                [SERVICE]: {
                    applicationName: 'orders-sapi',
                    properties: { 'http.port': '8081' },
                    secureProperties: { 'db.password': MASKED },
                },
            },
        },
        target: {
            provider: 'MC',
            targetId: 'cloudhub-us-east-2',
            deploymentSettings: {
                runtime: overrides.runtime ?? { version: '4.9.0', java: '17', releaseChannel: 'LTS' },
                updateStrategy: 'rolling',
                clustered: true,
                resources: { cpu: { limit: '1' }, memory: { limit: '1Gi' } },
                http: { inbound: { publicUrl: 'https://orders-sapi.example.test' } },
            },
            replicas: 2,
        },
        replicas: [
            { id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-1' },
            { id: 'r2', state: 'STARTED', currentDeploymentVersion: 'spec-1' },
        ],
        desiredVersion: 'spec-1',
        lastModifiedDate: 1_000,
    };
}

const catalog: RuntimeVersion[] = [
    { version: '4.9.0', releaseChannel: 'LTS', java: ['17'] },
    { version: '4.9.5', releaseChannel: 'LTS', java: ['17'] },
    { version: '4.10.1', releaseChannel: 'EDGE', java: ['17', '21'] },
];

function runningOn(spec: string, base: CH2Deployment = makeExisting()): CH2Deployment {
    return {
        ...base,
        status: 'APPLIED',
        application: { ...base.application, desiredState: 'STARTED' },
        replicas: base.replicas.map((r) => ({ ...r, state: 'STARTED', currentDeploymentVersion: spec })),
        desiredVersion: spec,
        lastModifiedDate: 5_000,
    };
}

function stopped(base: CH2Deployment = makeExisting()): CH2Deployment {
    return {
        ...base,
        application: { ...base.application, desiredState: 'STOPPED' },
        replicas: [],
        lastModifiedDate: 2_000,
    };
}

function makeClient(existing: CH2Deployment = makeExisting()) {
    return {
        cloudHub2: {
            findDetailByName: vi.fn().mockResolvedValue(existing),
            patchDeployment: vi.fn().mockResolvedValue({ ...existing, status: 'APPLYING', desiredVersion: 'spec-2' }),
            setDesiredState: vi.fn().mockResolvedValue(undefined),
            getDeployment: vi.fn().mockResolvedValue(runningOn('spec-2', existing)),
        },
        runtimes: {
            getTarget: vi.fn().mockResolvedValue({ id: 'cloudhub-us-east-2', runtimes: catalog }),
        },
    };
}

type FakeClient = ReturnType<typeof makeClient>;

const sandbox = { id: 'env-1', name: 'Sandbox', isProduction: false } as AppChangeRequest['env'];

function request(overrides: Partial<AppChangeRequest> = {}): AppChangeRequest {
    return { orgId: 'org-1', env: sandbox, appName: 'orders-sapi', ...overrides };
}

const plan = (client: FakeClient, overrides: Partial<AppChangeRequest> = {}) =>
    planAppChange(client as any, request(overrides));

function writesOf(client: FakeClient) {
    return client.cloudHub2.patchDeployment.mock.calls.length + client.cloudHub2.setDesiredState.mock.calls.length;
}

describe('planAppChange and executeAppChange', () => {
    let client: FakeClient;

    beforeEach(() => {
        client = makeClient();
    });

    it('combines version, runtime, settings and strategy into one PATCH that restates the target', async () => {
        const existing = makeExisting();
        const result = await plan(client, {
            ref: { version: '1.1.0' },
            runtime: { version: '4.9' },
            settings: { properties: { 'log.level': 'DEBUG' } },
            updateStrategy: 'recreate',
        });

        expect(result.blockers).toEqual([]);
        expect(result.noop).toBe(false);
        expect(result.mode).toBe('inPlace');
        expect(result.runtimeCheck).toMatchObject({
            checked: true,
            current: { version: '4.9.0', supported: true },
            requested: { version: '4.9', supported: true },
        });
        expect(result.changes).toEqual([
            { field: 'ref.version', from: '1.0.0', to: '1.1.0' },
            { field: 'runtime', from: '4.9.0', to: '4.9.5' },
            { field: 'updateStrategy', from: 'rolling', to: 'recreate' },
        ]);

        await executeAppChange(client as any, result);

        expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
        expect(client.cloudHub2.setDesiredState).not.toHaveBeenCalled();
        const [orgId, envId, deploymentId, body] = client.cloudHub2.patchDeployment.mock.calls[0];
        expect([orgId, envId, deploymentId]).toEqual(['org-1', 'env-1', 'dep-1']);
        expect(body).toEqual({
            application: {
                ref: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.1.0', packaging: 'jar' },
                configuration: {
                    [SERVICE]: {
                        applicationName: 'orders-sapi',
                        properties: { 'http.port': '8081', 'log.level': 'DEBUG' },
                        secureProperties: { 'db.password': MASKED },
                    },
                },
            },
            target: {
                provider: 'MC',
                targetId: 'cloudhub-us-east-2',
                replicas: 2,
                deploymentSettings: {
                    ...existing.target.deploymentSettings,
                    runtime: { version: '4.9.5', releaseChannel: 'LTS', java: '17' },
                    updateStrategy: 'recreate',
                },
            },
        });
        expect(body.application.desiredState).toBeUndefined();
    });

    it('sends only application.ref for a ref-only change', async () => {
        const result = await plan(client, { ref: { version: '1.2.0' } });
        await executeAppChange(client as any, result);

        expect(client.cloudHub2.patchDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', {
            application: { ref: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.2.0', packaging: 'jar' } },
        });
        expect(result.warnings.some((w) => w.startsWith('Rolling update'))).toBe(true);
    });

    it('looks the app up by name and fails when it does not exist', async () => {
        client.cloudHub2.findDetailByName.mockResolvedValue(null);
        await expect(plan(client, { ref: { version: '1.2.0' } })).rejects.toThrow(
            'Application "orders-sapi" not found in Sandbox',
        );
        expect(client.cloudHub2.findDetailByName).toHaveBeenCalledWith('org-1', 'env-1', 'orders-sapi');
    });

    it('marks production plans', async () => {
        const result = await plan(client, {
            env: { id: 'env-2', name: 'Production', isProduction: true } as AppChangeRequest['env'],
            ref: { version: '1.2.0' },
        });
        expect(result.production).toBe(true);
        expect(describeAppChange(result).production).toBe(true);
    });

    describe('stopStart', () => {
        it('stops, waits, applies the change with STARTED in one patch, then waits for the new spec', async () => {
            client.cloudHub2.getDeployment.mockResolvedValueOnce(stopped()).mockResolvedValue(runningOn('spec-2'));
            const result = await plan(client, { ref: { version: '1.1.0' }, mode: 'stopStart' });
            expect(result.steps).toEqual([
                'stop the application and wait until it is stopped',
                'apply the change and start in one update',
                'wait until every replica runs the new spec',
            ]);

            const outcome = await executeAppChange(client as any, result, { wait: true, pollIntervalMs: 0 });

            expect(client.cloudHub2.setDesiredState).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', 'STOPPED');
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
            expect(client.cloudHub2.patchDeployment.mock.calls[0][3]).toEqual({
                application: {
                    ref: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.1.0', packaging: 'jar' },
                    desiredState: 'STARTED',
                },
            });

            const order = [
                client.cloudHub2.setDesiredState.mock.invocationCallOrder[0],
                client.cloudHub2.getDeployment.mock.invocationCallOrder[0],
                client.cloudHub2.patchDeployment.mock.invocationCallOrder[0],
                client.cloudHub2.getDeployment.mock.invocationCallOrder[1],
            ];
            expect([...order].sort((a, b) => a - b)).toEqual(order);
            expect(outcome.performed).toEqual([
                'stop requested',
                'stopped',
                'change applied and start requested',
                'settled',
            ]);
            expect(outcome.snapshot).toMatchObject({ phase: 'RUNNING', settled: true });
        });

        it('does not apply the staleness check to the stop or to the start after it', async () => {
            // The platform may report the same lastModifiedDate throughout, and the patch may not
            // return a new spec version; state alone tells stop and start apart.
            const sameStamp = makeExisting();
            client.cloudHub2.getDeployment
                .mockResolvedValueOnce({ ...stopped(), lastModifiedDate: sameStamp.lastModifiedDate })
                .mockResolvedValue({ ...runningOn('spec-1'), lastModifiedDate: sameStamp.lastModifiedDate });
            client.cloudHub2.patchDeployment.mockResolvedValue({ ...sameStamp, desiredVersion: undefined });
            const result = await plan(client, { ref: { version: '1.1.0' }, mode: 'stopStart' });

            const outcome = await executeAppChange(client as any, result, {
                wait: true,
                pollIntervalMs: 0,
                timeoutMs: 1_000,
            });

            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
            expect(client.cloudHub2.getDeployment).toHaveBeenCalledTimes(2);
            expect(outcome.performed).toEqual([
                'stop requested',
                'stopped',
                'change applied and start requested',
                'settled',
            ]);
            expect(outcome.timedOut).toBe(false);
        });

        it('applies nothing when the stop never settles', async () => {
            client.cloudHub2.getDeployment.mockResolvedValue({
                ...makeExisting(),
                application: { ...makeExisting().application, desiredState: 'STOPPED' },
                lastModifiedDate: 2_000,
            });
            const result = await plan(client, { ref: { version: '1.1.0' }, mode: 'stopStart' });

            const error = await executeAppChange(client as any, result, {
                wait: true,
                pollIntervalMs: 0,
                timeoutMs: 0,
            }).catch((e: Error) => e);

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain('the change was not applied');
            expect((error as Error).message).toContain('STOPPING, timed out');
            expect(client.cloudHub2.setDesiredState).toHaveBeenCalledTimes(1);
            expect(client.cloudHub2.patchDeployment).not.toHaveBeenCalled();
        });

        it('skips the stop when the app is already stopped', async () => {
            const existing = makeExisting({ desiredState: 'STOPPED' });
            client = makeClient(existing);
            const result = await plan(client, { ref: { version: '1.1.0' }, mode: 'stopStart' });
            expect(result.steps[0]).toBe('apply the change and start in one update');

            await executeAppChange(client as any, result);
            expect(client.cloudHub2.setDesiredState).not.toHaveBeenCalled();
            expect(client.cloudHub2.patchDeployment.mock.calls[0][3].application.desiredState).toBe('STARTED');
        });

        it('restarts with only desiredState when nothing else changes', async () => {
            client.cloudHub2.getDeployment.mockResolvedValueOnce(stopped()).mockResolvedValue(runningOn('spec-2'));
            const result = await plan(client, { restart: true });
            expect(result.mode).toBe('stopStart');
            expect(result.noop).toBe(false);
            expect(result.patch).toEqual({ application: { desiredState: 'STARTED' } });
            expect(result.steps[1]).toBe('start the application');

            await executeAppChange(client as any, result, { wait: true, pollIntervalMs: 0 });
            expect(client.cloudHub2.setDesiredState).toHaveBeenCalledTimes(1);
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', {
                application: { desiredState: 'STARTED' },
            });
        });
    });

    describe('runtime checks', () => {
        it('blocks a runtime the target does not offer, with suggestions, before any write', async () => {
            const result = await plan(client, { ref: { version: '1.1.0' }, runtime: { version: '4.7.0' } });

            expect(result.runtimeCheck.requested).toEqual({ version: '4.7.0', supported: false });
            expect(result.runtimeCheck.suggestions).toEqual(['4.9.0 LTS java17', '4.10.1 EDGE java17']);
            expect(result.blockers).toHaveLength(1);
            expect(result.blockers[0]).toContain('Runtime 4.7.0 is not offered by cloudhub-us-east-2');
            expect(result.blockers[0]).toContain('4.9.0 LTS java17');

            await expect(executeAppChange(client as any, result)).rejects.toThrow('Runtime 4.7.0 is not offered');
            expect(writesOf(client)).toBe(0);
        });

        it('blocks a version change when the current runtime is retired', async () => {
            client = makeClient(makeExisting({ runtime: { version: '4.8.5:4e-java8' } }));
            const result = await plan(client, { ref: { version: '1.1.0' } });

            expect(result.runtimeCheck.current).toEqual({ version: '4.8.5', java: '8', supported: false });
            expect(result.runtimeCheck.suggestions).toEqual(['4.9.0 LTS java17', '4.10.1 EDGE java17']);
            expect(result.blockers[0]).toContain("The app's current runtime 4.8.5 (Java 8) is no longer offered");
            await expect(executeAppChange(client as any, result)).rejects.toThrow('no longer offered');
            expect(writesOf(client)).toBe(0);
        });

        it('allows the version change together with a supported runtime', async () => {
            client = makeClient(makeExisting({ runtime: { version: '4.8.5:4e-java8' } }));
            const result = await plan(client, { ref: { version: '1.1.0' }, runtime: { version: '4.9' } });

            expect(result.blockers).toEqual([]);
            expect(result.patch.target?.deploymentSettings.runtime).toEqual({
                version: '4.9.5',
                releaseChannel: 'LTS',
                java: '17',
            });
            expect(result.changes).toContainEqual({ field: 'java', from: '8', to: '17' });
        });

        it('does not block a restart on a retired runtime', async () => {
            client = makeClient(makeExisting({ runtime: { version: '4.8.5:4e-java8' } }));
            const result = await plan(client, { restart: true, mode: 'stopStart' });

            expect(result.runtimeCheck.current.supported).toBe(false);
            expect(result.blockers).toEqual([]);
        });

        it('warns and proceeds when the catalog is unavailable', async () => {
            client.runtimes.getTarget.mockRejectedValue(new Error('service unavailable'));
            const result = await plan(client, { runtime: { version: '4.9.5' } });

            expect(result.runtimeCheck).toMatchObject({
                checked: false,
                reason: 'runtime catalog unavailable: service unavailable',
            });
            expect(result.runtimeCheck.current.supported).toBeUndefined();
            expect(result.warnings).toContain(
                'Runtime 4.9.5 was not validated (runtime catalog unavailable: service unavailable)',
            );
            expect(result.blockers).toEqual([]);

            await executeAppChange(client as any, result);
            expect(client.cloudHub2.patchDeployment.mock.calls[0][3].target.deploymentSettings.runtime).toEqual({
                version: '4.9.5',
                releaseChannel: 'LTS',
                java: '17',
            });
        });

        it('reports a target missing from the catalog as unchecked', async () => {
            client.runtimes.getTarget.mockResolvedValue(null);
            const result = await plan(client, { ref: { version: '1.1.0' } });
            expect(result.runtimeCheck.checked).toBe(false);
            expect(result.runtimeCheck.reason).toContain('is not in the organization');
            expect(result.blockers).toEqual([]);
        });
    });

    describe('noop and strategy', () => {
        it('plans nothing when the request matches the deployment', async () => {
            const result = await plan(client, {
                ref: { version: '1.0.0' },
                runtime: { version: '4.9.0' },
                updateStrategy: 'rolling',
            });

            expect(result.noop).toBe(true);
            expect(result.changes).toEqual([]);
            expect(result.patch).toEqual({});
            expect(result.steps).toEqual([]);
            expect(describeAppChange(result).noop).toBe(true);

            const outcome = await executeAppChange(client as any, result, { wait: true });
            expect(outcome.performed).toEqual([]);
            expect(writesOf(client)).toBe(0);
            expect(client.cloudHub2.getDeployment).not.toHaveBeenCalled();
        });

        it('lists an updateStrategy change and sends it in the target', async () => {
            const result = await plan(client, { updateStrategy: 'recreate' });

            expect(result.changes).toEqual([{ field: 'updateStrategy', from: 'rolling', to: 'recreate' }]);
            expect(result.patch.target?.deploymentSettings.updateStrategy).toBe('recreate');
            expect(result.patch.target?.deploymentSettings.runtime).toEqual({
                version: '4.9.0',
                java: '17',
                releaseChannel: 'LTS',
            });
            expect(result.warnings.some((w) => w.startsWith('Rolling update'))).toBe(false);
        });
    });

    describe('waiting', () => {
        it('waits for the spec version returned by the patch', async () => {
            client.cloudHub2.getDeployment
                .mockResolvedValueOnce(runningOn('spec-1'))
                .mockResolvedValue(runningOn('spec-2'));
            const result = await plan(client, { ref: { version: '1.1.0' } });
            const outcome = await executeAppChange(client as any, result, { wait: true, pollIntervalMs: 0 });

            expect(client.cloudHub2.getDeployment).toHaveBeenCalledTimes(2);
            expect(outcome.snapshot).toMatchObject({ phase: 'RUNNING', settled: true });
            expect(outcome.performed).toEqual(['change applied', 'settled']);
        });

        it('keeps the staleness check for an in-place change of a running app', async () => {
            // The patch returns no new spec version, so only lastModifiedDate shows the change landed.
            client.cloudHub2.patchDeployment.mockResolvedValue({ ...makeExisting(), desiredVersion: undefined });
            client.cloudHub2.getDeployment
                .mockResolvedValueOnce(makeExisting())
                .mockResolvedValue({ ...makeExisting(), lastModifiedDate: 9_000 });
            const result = await plan(client, { ref: { version: '1.1.0' } });
            const outcome = await executeAppChange(client as any, result, {
                wait: true,
                pollIntervalMs: 0,
                timeoutMs: 1_000,
            });

            expect(client.cloudHub2.getDeployment).toHaveBeenCalledTimes(2);
            expect(outcome.snapshot).toMatchObject({ phase: 'RUNNING', settled: true });
        });
    });
});

describe('secret handling', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-app-change-')));
        fs.writeFileSync(path.join(dir, '.env'), `SF_PASSWORD=${SECRET}\nUNUSED=other-value\n`);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('resolves file and env sources and returns the secret values', () => {
        const { change, secretValues } = resolveSettingsInput(
            {
                properties: { 'http.port': '8082', 'api.token': 'plain-token-value' },
                securePropertiesFrom: [
                    { file: '.env', keys: ['SF_PASSWORD'], rename: { SF_PASSWORD: 'sf.password' } },
                    { env: { 'db.password': 'ANC_TEST_DB_PASSWORD' } },
                ],
                removeProperties: ['old.key'],
            },
            { projectRoot: dir, env: { ANC_TEST_DB_PASSWORD: 'env-secret-value' } },
        );

        expect(change).toEqual({
            properties: { 'http.port': '8082', 'api.token': 'plain-token-value' },
            secureProperties: { 'sf.password': SECRET, 'db.password': 'env-secret-value' },
            removeProperties: ['old.key'],
        });
        expect(secretValues).toEqual(expect.arrayContaining([SECRET, 'env-secret-value', 'plain-token-value']));
        expect(secretValues).not.toContain('8082');
    });

    it('lets inline values override sourced ones and returns no change for empty input', () => {
        const { change } = resolveSettingsInput(
            { propertiesFrom: [{ file: '.env', keys: ['UNUSED'] }], properties: { UNUSED: 'inline' } },
            { projectRoot: dir },
        );
        expect(change?.properties).toEqual({ UNUSED: 'inline' });
        expect(resolveSettingsInput({ properties: {}, removeProperties: [] })).toEqual({
            change: undefined,
            secretValues: [],
        });
        expect(resolveSettingsInput(undefined)).toEqual({ change: undefined, secretValues: [] });
    });

    it('keeps secret values out of describeAppChange', async () => {
        const client = makeClient();
        const { change, secretValues } = resolveSettingsInput(
            {
                properties: { 'api.token': SECRET, mirror: SECRET },
                securePropertiesFrom: [{ file: '.env', keys: ['SF_PASSWORD'] }],
            },
            { projectRoot: dir },
        );
        const result = await plan(client, { settings: change, secretValues });
        const text = JSON.stringify(describeAppChange(result));

        expect(text).not.toContain(SECRET);
        expect(result.settings?.diff.secureAdded).toEqual(['SF_PASSWORD']);
        expect(text).toContain('SF_PASSWORD');
    });

    it('scrubs a secret echoed back in a patch error', async () => {
        const client = makeClient();
        client.cloudHub2.patchDeployment.mockRejectedValue(new Error(`Invalid value "${SECRET}" for sf.password`));
        const { change, secretValues } = resolveSettingsInput(
            { securePropertiesFrom: [{ file: '.env', keys: ['SF_PASSWORD'] }] },
            { projectRoot: dir },
        );
        const result = await plan(client, { settings: change, secretValues });

        const error = await executeAppChange(client as any, result).catch((e: Error) => e);
        expect((error as Error).message).toContain(`Invalid value "${MASKED}" for sf.password`);
        expect((error as Error).message).not.toContain(SECRET);
    });

    it('reports a failed start after a stop as leaving the app stopped', async () => {
        const client = makeClient();
        client.cloudHub2.getDeployment.mockResolvedValue(stopped());
        client.cloudHub2.patchDeployment.mockRejectedValue(new Error('runtime rejected'));
        const result = await plan(client, { ref: { version: '1.1.0' }, mode: 'stopStart' });

        const error = await executeAppChange(client as any, result, { wait: true, pollIntervalMs: 0 }).catch(
            (e: Error) => e,
        );
        expect((error as Error).message).toContain('runtime rejected');
        expect((error as Error).message).toContain('The application was stopped and is still stopped');
    });
});
