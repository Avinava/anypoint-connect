import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAppDeployTools } from '../../../src/mcp/tools/apps-deploy.js';
import { registerAppLifecycleTools } from '../../../src/mcp/tools/apps-lifecycle.js';
import { PROJECT_ROOT_ENV } from '../../../src/safety/paths.js';

const SERVICE = 'mule.agent.application.properties.service';
const currentRef = { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' };

function makeDetail() {
    return {
        id: 'dep-1',
        name: 'orders-sapi',
        status: 'APPLIED',
        application: {
            desiredState: 'STARTED',
            ref: { ...currentRef },
            configuration: {
                [SERVICE]: {
                    applicationName: 'orders-sapi',
                    properties: { 'http.port': '8081' },
                    secureProperties: { 'db.password': '******' },
                },
            },
        },
        target: {
            provider: 'MC',
            targetId: 'cloudhub-us-east-2',
            deploymentSettings: { runtime: { version: '4.9.0', java: '17', releaseChannel: 'LTS' } },
            replicas: 1,
        },
        replicas: [{ id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-1' }],
        desiredVersion: 'spec-1',
        lastModifiedDate: 1_000,
    };
}

function runningOnSpec2() {
    const detail = makeDetail();
    return {
        ...detail,
        replicas: [{ id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-2' }],
        desiredVersion: 'spec-2',
        lastModifiedDate: 2_000,
    };
}

const sandbox = { id: 'env-1', name: 'Sandbox', isProduction: false };
const production = { id: 'env-2', name: 'Production', isProduction: true };

describe('application deploy MCP tools', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        runtimes: { getTarget: vi.fn() },
        exchange: { downloadAppJar: vi.fn() },
        cloudHub2: {
            findDetailByName: vi.fn(),
            patchDeployment: vi.fn(),
            setDesiredState: vi.fn(),
            getDeployment: vi.fn(),
            getDeploymentSpecs: vi.fn(),
            createDeployment: vi.fn(),
        },
    };
    const parse = (result: any) => JSON.parse(result.content[0].text);
    const writes = () =>
        client.cloudHub2.patchDeployment.mock.calls.length +
        client.cloudHub2.setDesiredState.mock.calls.length +
        client.cloudHub2.createDeployment.mock.calls.length;

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue(sandbox);
        client.runtimes.getTarget.mockResolvedValue({
            id: 'cloudhub-us-east-2',
            runtimes: [
                { version: '4.9.0', releaseChannel: 'LTS', java: ['17'] },
                { version: '4.9.5', releaseChannel: 'LTS', java: ['17'] },
                { version: '4.10.1', releaseChannel: 'EDGE', java: ['17'] },
            ],
        });
        client.cloudHub2.findDetailByName.mockResolvedValue(makeDetail());
        client.cloudHub2.patchDeployment.mockResolvedValue({
            ...makeDetail(),
            status: 'APPLYING',
            desiredVersion: 'spec-2',
        });
        client.cloudHub2.setDesiredState.mockResolvedValue(undefined);
        client.cloudHub2.getDeployment.mockResolvedValue(runningOnSpec2());
        registerAppDeployTools(server as any, client as any);
        registerAppLifecycleTools(server as any, client as any);
    });

    it('registers the deploy tools', () => {
        expect([...handlers.keys()]).toEqual(
            expect.arrayContaining(['deploy_jar', 'deploy_app', 'update_app', 'update_app_artifact', 'rollback_app']),
        );
    });

    describe('update_app', () => {
        const args = {
            appName: 'orders-sapi',
            environment: 'Sandbox',
            version: '1.1.0',
            properties: { 'log.level': 'DEBUG' },
        };

        it('previews by default without writing', async () => {
            const result = await handlers.get('update_app')!(args);
            const body = parse(result);

            expect(result.isError).toBeUndefined();
            expect(body.dryRun).toBe(true);
            expect(body.changes).toEqual([{ field: 'ref.version', from: '1.0.0', to: '1.1.0' }]);
            expect(body.settings.added).toEqual([{ key: 'log.level', to: 'DEBUG' }]);
            expect(body.steps).toEqual([
                'apply the change in one update (one new spec)',
                'wait until every replica runs the new spec',
            ]);
            expect(writes()).toBe(0);
            expect(client.cloudHub2.getDeployment).not.toHaveBeenCalled();
        });

        it('applies on confirm in one patch and waits by default', async () => {
            const result = await handlers.get('update_app')!({ ...args, confirm: true });
            const body = parse(result);

            expect(result.isError).toBeUndefined();
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
            expect(client.cloudHub2.patchDeployment.mock.calls[0][3]).toEqual({
                application: {
                    ref: { ...currentRef, version: '1.1.0' },
                    configuration: {
                        [SERVICE]: {
                            applicationName: 'orders-sapi',
                            properties: { 'http.port': '8081', 'log.level': 'DEBUG' },
                            secureProperties: { 'db.password': '******' },
                        },
                    },
                },
            });
            expect(client.cloudHub2.getDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1');
            expect(body).toMatchObject({
                message: 'Updated "orders-sapi" in Sandbox',
                deploymentId: 'dep-1',
                phase: 'RUNNING',
                settled: true,
                performed: ['change applied', 'settled'],
            });
        });

        it('skips the wait when wait is false', async () => {
            const body = parse(await handlers.get('update_app')!({ ...args, confirm: true, wait: false }));
            expect(client.cloudHub2.getDeployment).not.toHaveBeenCalled();
            expect(body.tip).toContain('get_app_status');
        });

        it('requires confirmProduction in production', async () => {
            client.accessManagement.resolveEnvironment.mockResolvedValue(production);
            const released = Buffer.from(
                zipSync({
                    'META-INF/mule-build/build-info.json': strToU8(
                        JSON.stringify({
                            schemaVersion: 1,
                            tool: 'mule-build',
                            toolVersion: '3.2.0',
                            stripped: false,
                            productionDeployable: true,
                        }),
                    ),
                }),
            );
            client.exchange.downloadAppJar.mockResolvedValue({
                buffer: released,
                sha256: createHash('sha256').update(released).digest('hex'),
                md5Matches: true,
                fileName: 'orders-sapi.jar',
            });
            const handler = handlers.get('update_app')!;

            const preview = parse(await handler({ ...args, environment: 'Production' }));
            expect(preview).toMatchObject({ dryRun: true, production: true });

            const refused = await handler({ ...args, environment: 'Production', confirm: true });
            expect(refused.isError).toBe(true);
            expect(parse(refused).refused).toBe(true);
            expect(writes()).toBe(0);

            const applied = await handler({
                ...args,
                environment: 'Production',
                confirm: true,
                confirmProduction: true,
            });
            expect(applied.isError).toBeUndefined();
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
        });

        it('refuses a runtime the target does not offer, even with confirm', async () => {
            const result = await handlers.get('update_app')!({ ...args, runtime: '4.7.0', confirm: true });
            const body = parse(result);

            expect(result.isError).toBe(true);
            expect(body.refused).toBe(true);
            expect(body.blockers[0]).toContain('Runtime 4.7.0 is not offered');
            expect(body.runtimeCheck.suggestions).toEqual(['4.9.0 LTS java17', '4.10.1 EDGE java17']);
            expect(writes()).toBe(0);
        });

        it('reports a noop without writing', async () => {
            const body = parse(
                await handlers.get('update_app')!({
                    appName: 'orders-sapi',
                    environment: 'Sandbox',
                    version: '1.0.0',
                    confirm: true,
                }),
            );
            expect(body.noop).toBe(true);
            expect(writes()).toBe(0);
        });

        it('stops, applies and starts in stopStart mode', async () => {
            client.cloudHub2.getDeployment
                .mockResolvedValueOnce({
                    ...makeDetail(),
                    application: { ...makeDetail().application, desiredState: 'STOPPED' },
                    replicas: [],
                })
                .mockResolvedValue(runningOnSpec2());
            const body = parse(await handlers.get('update_app')!({ ...args, mode: 'stopStart', confirm: true }));

            expect(client.cloudHub2.setDesiredState).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', 'STOPPED');
            expect(client.cloudHub2.patchDeployment.mock.calls[0][3].application.desiredState).toBe('STARTED');
            expect(body.performed).toEqual([
                'stop requested',
                'stopped',
                'change applied and start requested',
                'settled',
            ]);
        });
    });

    it('update_app_artifact changes the runtime in the same patch', async () => {
        const result = await handlers.get('update_app_artifact')!({
            appName: 'orders-sapi',
            environment: 'Sandbox',
            version: '1.1.0',
            runtime: '4.9',
            confirm: true,
        });

        expect(result.isError).toBeUndefined();
        expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
        expect(client.cloudHub2.patchDeployment.mock.calls[0][3]).toEqual({
            application: { ref: { ...currentRef, version: '1.1.0' } },
            target: {
                provider: 'MC',
                targetId: 'cloudhub-us-east-2',
                replicas: 1,
                deploymentSettings: { runtime: { version: '4.9.5', releaseChannel: 'LTS', java: '17' } },
            },
        });
        expect(parse(result).changes).toEqual([
            { field: 'ref.version', from: '1.0.0', to: '1.1.0' },
            { field: 'runtime', from: '4.9.0', to: '4.9.5' },
        ]);
    });

    describe('rollback_app', () => {
        const previousRef = { ...currentRef, version: '0.9.0' };

        beforeEach(() => {
            client.cloudHub2.getDeploymentSpecs.mockResolvedValue([
                { version: 'spec-1', application: { ref: { ...currentRef } } },
                { version: 'spec-0', application: { ref: previousRef } },
            ]);
        });

        it('previews the historical ref without writing', async () => {
            const body = parse(await handlers.get('rollback_app')!({ appName: 'orders-sapi', environment: 'Sandbox' }));
            expect(body.dryRun).toBe(true);
            expect(body.changes).toEqual([{ field: 'ref.version', from: '1.0.0', to: '0.9.0' }]);
            expect(writes()).toBe(0);
        });

        it('patches the historical ref on confirm', async () => {
            const result = await handlers.get('rollback_app')!({
                appName: 'orders-sapi',
                environment: 'Sandbox',
                confirm: true,
            });
            expect(result.isError).toBeUndefined();
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', {
                application: { ref: previousRef },
            });
            expect(parse(result).message).toBe('Rolled back "orders-sapi" in Sandbox');
        });

        it('reports a noop when there is no distinct earlier artifact', async () => {
            client.cloudHub2.getDeploymentSpecs.mockResolvedValue([
                { version: 'spec-1', application: { ref: { ...currentRef } } },
            ]);
            const body = parse(
                await handlers.get('rollback_app')!({ appName: 'orders-sapi', environment: 'Sandbox', confirm: true }),
            );
            expect(body.noop).toBe(true);
            expect(writes()).toBe(0);
        });
    });

    describe('deploy_app', () => {
        it('refuses create-only settings for an existing app', async () => {
            const result = await handlers.get('deploy_app')!({
                appName: 'orders-sapi',
                environment: 'Sandbox',
                groupId: 'org-1',
                artifactId: 'orders-sapi',
                version: '1.1.0',
                vcores: '0.2',
                confirm: true,
            });
            expect(result.isError).toBe(true);
            expect(parse(result)).toMatchObject({ refused: true });
            expect(parse(result).message).toContain('vcores apply only to a new app');
            expect(writes()).toBe(0);
        });

        it('updates an existing app through the change workflow', async () => {
            const result = await handlers.get('deploy_app')!({
                appName: 'orders-sapi',
                environment: 'Sandbox',
                groupId: 'org-1',
                artifactId: 'orders-sapi',
                version: '1.1.0',
                confirm: true,
            });
            expect(result.isError).toBeUndefined();
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', {
                application: { ref: { ...currentRef, version: '1.1.0' } },
            });
            expect(client.cloudHub2.createDeployment).not.toHaveBeenCalled();
        });

        it('previews a new app without creating it', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(null);
            const body = parse(
                await handlers.get('deploy_app')!({
                    appName: 'orders-sapi',
                    environment: 'Sandbox',
                    groupId: 'org-1',
                    artifactId: 'orders-sapi',
                    version: '1.1.0',
                }),
            );
            expect(body).toMatchObject({ dryRun: true, action: 'create new deployment' });
            expect(writes()).toBe(0);
        });
    });
});

describe('transcript safety for secret sources', () => {
    const SECRET = 'transcript-secret-value-42';
    const ENV_SECRET = 'env-sourced-secret-value-77';
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const client = {
        getDefaultOrgId: vi.fn().mockResolvedValue('org-1'),
        accessManagement: { resolveEnvironment: vi.fn().mockResolvedValue(sandbox) },
        runtimes: { getTarget: vi.fn().mockResolvedValue(null) },
        cloudHub2: {
            findDetailByName: vi.fn(),
            patchDeployment: vi.fn(),
            setDesiredState: vi.fn(),
            getDeployment: vi.fn(),
        },
    };
    const savedRoot = process.env[PROJECT_ROOT_ENV];
    let dir: string;
    const texts: string[] = [];

    async function call(tool: string, input: Record<string, unknown>) {
        const result = await handlers.get(tool)!(input);
        for (const item of result.content) texts.push(item.text);
        return result;
    }

    beforeEach(() => {
        handlers.clear();
        texts.length = 0;
        vi.clearAllMocks();
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-transcript-')));
        fs.writeFileSync(path.join(dir, '.env'), `SF_PASSWORD=${SECRET}\n`);
        process.env[PROJECT_ROOT_ENV] = dir;
        process.env.ANC_TRANSCRIPT_TEST_SECRET = ENV_SECRET;
        client.cloudHub2.findDetailByName.mockResolvedValue(makeDetail());
        client.cloudHub2.patchDeployment.mockResolvedValue({ ...makeDetail(), desiredVersion: 'spec-2' });
        client.cloudHub2.getDeployment.mockResolvedValue(runningOnSpec2());
        registerAppDeployTools(server as any, client as any);
        registerAppLifecycleTools(server as any, client as any);
    });

    afterEach(() => {
        if (savedRoot === undefined) delete process.env[PROJECT_ROOT_ENV];
        else process.env[PROJECT_ROOT_ENV] = savedRoot;
        delete process.env.ANC_TRANSCRIPT_TEST_SECRET;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const settings = {
        appName: 'orders-sapi',
        environment: 'Sandbox',
        securePropertiesFrom: [
            { file: '.env', keys: ['SF_PASSWORD'], rename: { SF_PASSWORD: 'sf.password' } },
            { env: { 'api.token': 'ANC_TRANSCRIPT_TEST_SECRET' } },
        ],
    };

    function expectNoSecret() {
        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) {
            expect(text).not.toContain(SECRET);
            expect(text).not.toContain(ENV_SECRET);
        }
    }

    it('keeps sourced secrets out of the update_app_settings preview, result and error', async () => {
        const preview = await call('update_app_settings', settings);
        expect(JSON.parse(preview.content[0].text).dryRun).toBe(true);

        const applied = await call('update_app_settings', { ...settings, confirm: true });
        expect(applied.isError).toBeUndefined();
        // The values did reach the platform, only the transcript is clean.
        const sent = client.cloudHub2.patchDeployment.mock.calls[0][3].application.configuration[SERVICE];
        expect(sent.secureProperties).toEqual({
            'db.password': '******',
            'sf.password': SECRET,
            'api.token': ENV_SECRET,
        });

        client.cloudHub2.patchDeployment.mockRejectedValueOnce(
            new Error(`Rejected property sf.password=${SECRET} and api.token=${ENV_SECRET}`),
        );
        const failed = await call('update_app_settings', { ...settings, confirm: true });
        expect(failed.isError).toBe(true);
        expect(failed.content[0].text).toContain('Rejected property sf.password=******');

        expectNoSecret();
    });

    it('keeps sourced secrets out of update_app with wait and a stop-start error', async () => {
        await call('update_app', { ...settings, version: '1.1.0' });
        await call('update_app', { ...settings, version: '1.1.0', confirm: true });

        client.cloudHub2.setDesiredState.mockRejectedValueOnce(new Error(`stop failed near ${SECRET}`));
        const failed = await call('update_app', { ...settings, version: '1.1.0', mode: 'stopStart', confirm: true });
        expect(failed.isError).toBe(true);

        expectNoSecret();
    });

    it('keeps a secret plain value echoed by the platform out of the response', async () => {
        client.cloudHub2.patchDeployment.mockRejectedValueOnce(new Error(`bad value ${SECRET}`));
        await call('update_app', {
            appName: 'orders-sapi',
            environment: 'Sandbox',
            properties: { 'db.password.plain': SECRET },
            confirm: true,
        });
        expectNoSecret();
    });
});
