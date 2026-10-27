import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    log: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        header: vi.fn(),
        kv: vi.fn(),
        bold: vi.fn(),
        dim: vi.fn(),
    },
    printTable: vi.fn(),
    spinner: { text: '', succeed: vi.fn(), fail: vi.fn(), stop: vi.fn(), start: vi.fn() },
}));

vi.mock('../../src/commands/shared.js', () => ({ createClient: mocks.createClient }));
vi.mock('../../src/utils/logger.js', () => ({ log: mocks.log }));
vi.mock('../../src/utils/formatter.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/formatter.js')>()),
    printTable: mocks.printTable,
}));
vi.mock('ora', () => ({
    default: () => {
        mocks.spinner.start.mockReturnValue(mocks.spinner);
        return mocks.spinner;
    },
}));

import { createAppsCommand } from '../../src/commands/apps.js';

describe('apps delete CLI', () => {
    const detail = {
        id: 'dep-1',
        name: 'sample-app',
        status: 'APPLIED',
        application: {
            desiredState: 'STARTED',
            ref: { groupId: 'org-1', artifactId: 'sample-app', version: '1.0.0', packaging: 'jar' },
        },
        target: {
            provider: 'MC',
            targetId: 'shared-region-1',
            deploymentSettings: { runtime: { version: '4.9.0' } },
            replicas: 1,
        },
        replicas: [{ state: 'RUNNING' }],
    };
    const client = {
        getDefaultOrgId: vi.fn().mockResolvedValue('org-1'),
        accessManagement: {
            resolveEnvironment: vi.fn().mockResolvedValue({
                id: 'env-1',
                name: 'Test',
                isProduction: false,
            }),
        },
        cloudHub2: {
            findDetailByName: vi.fn().mockResolvedValue(detail),
            deleteDeployment: vi.fn().mockResolvedValue(undefined),
            waitForDeploymentDeletion: vi.fn().mockResolvedValue({ verifiedAbsent: true }),
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockReturnValue(client);
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-1',
            name: 'Test',
            isProduction: false,
        });
        client.cloudHub2.findDetailByName.mockResolvedValue(detail);
        client.cloudHub2.waitForDeploymentDeletion.mockResolvedValue({ verifiedAbsent: true });
        process.exitCode = undefined;
    });

    it('prints a dry-run preview by default', async () => {
        await createAppsCommand().parseAsync(['node', 'apps', 'delete', 'sample-app', '--env', 'Test']);

        expect(mocks.log.header).toHaveBeenCalledWith('Delete application deployment — dry run');
        expect(mocks.log.kv).toHaveBeenCalledWith('Deployment ID', 'dep-1');
        expect(client.cloudHub2.deleteDeployment).not.toHaveBeenCalled();
    });

    it('deletes and verifies only when the confirmation ID matches', async () => {
        await createAppsCommand().parseAsync([
            'node',
            'apps',
            'delete',
            'sample-app',
            '--env',
            'Test',
            '--confirm',
            'dep-1',
        ]);

        expect(client.cloudHub2.deleteDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1');
        expect(client.cloudHub2.waitForDeploymentDeletion).toHaveBeenCalledWith(
            'org-1',
            'env-1',
            'sample-app',
            'dep-1',
        );
        expect(mocks.log.success).toHaveBeenCalledWith('Deleted deployment from Test and verified it is absent');
    });

    it('refuses a stale confirmation ID', async () => {
        await createAppsCommand().parseAsync([
            'node',
            'apps',
            'delete',
            'sample-app',
            '--env',
            'Test',
            '--confirm',
            'dep-old',
        ]);

        expect(client.cloudHub2.deleteDeployment).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
    });

    it('requires an explicit production acknowledgement', async () => {
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-prod',
            name: 'Production',
            isProduction: true,
        });

        await createAppsCommand().parseAsync([
            'node',
            'apps',
            'delete',
            'sample-app',
            '--env',
            'Production',
            '--confirm',
            'dep-1',
        ]);
        expect(client.cloudHub2.deleteDeployment).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);

        process.exitCode = undefined;
        await createAppsCommand().parseAsync([
            'node',
            'apps',
            'delete',
            'sample-app',
            '--env',
            'Production',
            '--confirm',
            'dep-1',
            '--allow-production',
        ]);
        expect(client.cloudHub2.deleteDeployment).toHaveBeenCalledWith('org-1', 'env-prod', 'dep-1');
    });

    it('accepts a user-level pre-approval that names delete_app in place of --allow-production', async () => {
        const { savePreapproval } = await import('../../src/safety/preapproval.js');
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-prod',
            name: 'Production',
            isProduction: true,
        });
        const args = ['node', 'apps', 'delete', 'sample-app', '--env', 'Production', '--confirm', 'dep-1'];
        const scope = { orgId: 'org-1', environmentId: 'env-prod' };

        savePreapproval(scope, { ...scope, tools: 'all-mutating' });
        await createAppsCommand().parseAsync(args);
        expect(client.cloudHub2.deleteDeployment).not.toHaveBeenCalled();

        savePreapproval(scope, { ...scope, tools: ['delete_app'] });
        process.exitCode = undefined;
        await createAppsCommand().parseAsync(args);
        expect(client.cloudHub2.deleteDeployment).toHaveBeenCalledWith('org-1', 'env-prod', 'dep-1');
        savePreapproval(scope, null);
    });
});

describe('apps change CLI', () => {
    const SERVICE = 'mule.agent.application.properties.service';
    const PLAIN_SECRET = 'plaintext-db-password-1';
    const ENV_SECRET = 'cli-env-secret-value-9';
    const ref = { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' };
    const makeDetail = () => ({
        id: 'dep-1',
        name: 'orders-sapi',
        status: 'APPLIED',
        application: {
            desiredState: 'STARTED',
            ref: { ...ref },
            configuration: {
                [SERVICE]: {
                    applicationName: 'orders-sapi',
                    properties: { 'http.port': '8081', 'db.password': PLAIN_SECRET },
                    secureProperties: { 'sf.token': '******' },
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
    });
    const stoppedDetail = () => ({
        ...makeDetail(),
        application: { ...makeDetail().application, desiredState: 'STOPPED' },
        replicas: [],
    });
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        runtimes: { getTarget: vi.fn() },
        cloudHub2: {
            findDetailByName: vi.fn(),
            patchDeployment: vi.fn(),
            setDesiredState: vi.fn(),
            getDeployment: vi.fn(),
        },
    };
    const run = (...args: string[]) => createAppsCommand().parseAsync(['node', 'apps', ...args]);
    const writes = () =>
        client.cloudHub2.patchDeployment.mock.calls.length + client.cloudHub2.setDesiredState.mock.calls.length;
    const allLogged = () =>
        JSON.stringify([
            ...Object.values(mocks.log).map((fn) => fn.mock.calls),
            mocks.printTable.mock.calls,
            mocks.spinner.succeed.mock.calls,
            mocks.spinner.fail.mock.calls,
        ]);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockReturnValue(client);
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-1',
            name: 'Sandbox',
            isProduction: false,
        });
        client.runtimes.getTarget.mockResolvedValue({
            id: 'cloudhub-us-east-2',
            runtimes: [
                { version: '4.9.0', releaseChannel: 'LTS', java: ['17'] },
                { version: '4.9.5', releaseChannel: 'LTS', java: ['17'] },
            ],
        });
        client.cloudHub2.findDetailByName.mockResolvedValue(makeDetail());
        client.cloudHub2.patchDeployment.mockResolvedValue({ ...makeDetail(), desiredVersion: 'spec-2' });
        client.cloudHub2.setDesiredState.mockResolvedValue(undefined);
        client.cloudHub2.getDeployment.mockResolvedValue(stoppedDetail());
        process.exitCode = undefined;
    });

    afterEach(() => {
        delete process.env.ANC_CLI_TEST_SECRET;
        process.exitCode = undefined;
    });

    describe('settings get', () => {
        it('masks secret-looking plain values and suggests moving them to secure', async () => {
            await run('settings', 'get', 'orders-sapi', '--env', 'Sandbox');

            expect(mocks.printTable).toHaveBeenCalledWith(
                ['Property', 'Value'],
                [
                    ['db.password', '******…-1'],
                    ['http.port', '8081'],
                ],
            );
            expect(mocks.log.kv).toHaveBeenCalledWith('Secure properties', 'sf.token');
            expect(mocks.log.warn).toHaveBeenCalledWith(expect.stringContaining('--move-to-secure db.password'));
            expect(allLogged()).not.toContain(PLAIN_SECRET);
        });

        it('shows the value with --reveal', async () => {
            await run('settings', 'get', 'orders-sapi', '--env', 'Sandbox', '--reveal');
            expect(mocks.printTable.mock.calls[0][1]).toContainEqual(['db.password', PLAIN_SECRET]);
        });
    });

    describe('settings set', () => {
        it('previews with --dry-run and writes nothing', async () => {
            process.env.ANC_CLI_TEST_SECRET = ENV_SECRET;
            await run(
                'settings',
                'set',
                'orders-sapi',
                '--env',
                'Sandbox',
                '--set',
                'log.level=DEBUG',
                '--secure-from-env',
                'sf.password=ANC_CLI_TEST_SECRET',
                '--remove',
                'http.port',
                '--dry-run',
            );

            expect(writes()).toBe(0);
            expect(mocks.log.kv).toHaveBeenCalledWith('  + property', 'log.level=DEBUG');
            expect(mocks.log.kv).toHaveBeenCalledWith('  + secure', 'sf.password');
            expect(mocks.log.kv).toHaveBeenCalledWith('  - property', 'http.port');
            expect(mocks.log.info).toHaveBeenCalledWith('Dry run: nothing was changed.');
            expect(process.exitCode).toBeUndefined();
            expect(allLogged()).not.toContain(ENV_SECRET);
        });

        it('fails without writing when the environment variable is missing', async () => {
            await run(
                'settings',
                'set',
                'orders-sapi',
                '--env',
                'Sandbox',
                '--secure-from-env',
                'sf.password=ANC_CLI_TEST_SECRET',
            );
            expect(writes()).toBe(0);
            expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining('ANC_CLI_TEST_SECRET'));
            expect(process.exitCode).toBe(1);
        });
    });

    describe('update', () => {
        it('previews version and runtime with --dry-run and writes nothing', async () => {
            await run(
                'update',
                'orders-sapi',
                '--env',
                'Sandbox',
                '--version',
                '1.1.0',
                '--runtime',
                '4.9',
                '--dry-run',
            );

            expect(writes()).toBe(0);
            expect(mocks.log.kv).toHaveBeenCalledWith('  ref.version', '1.0.0 -> 1.1.0');
            expect(mocks.log.kv).toHaveBeenCalledWith('  runtime', '4.9.0 -> 4.9.5');
            expect(mocks.log.info).toHaveBeenCalledWith('Dry run: nothing was changed.');
        });

        it('exits non-zero without writing when the runtime is not offered', async () => {
            await run('update', 'orders-sapi', '--env', 'Sandbox', '--runtime', '4.7.0', '--no-wait');

            expect(writes()).toBe(0);
            expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining('Runtime 4.7.0 is not offered'));
            expect(process.exitCode).toBe(1);
        });

        it('applies with --no-wait in one patch', async () => {
            await run('update', 'orders-sapi', '--env', 'Sandbox', '--version', '1.1.0', '--no-wait');

            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', {
                application: { ref: { ...ref, version: '1.1.0' } },
            });
            expect(client.cloudHub2.getDeployment).not.toHaveBeenCalled();
            expect(mocks.spinner.succeed).toHaveBeenCalled();
        });
    });

    describe('stop and start', () => {
        it('stops the app with setDesiredState', async () => {
            await run('stop', 'orders-sapi', '--env', 'Sandbox');

            expect(client.cloudHub2.setDesiredState).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', 'STOPPED');
            expect(client.cloudHub2.patchDeployment).not.toHaveBeenCalled();
            expect(mocks.log.success).toHaveBeenCalledWith('Stop requested for orders-sapi');
        });

        it('waits for the stop with --wait even when lastModifiedDate does not move', async () => {
            await run('stop', 'orders-sapi', '--env', 'Sandbox', '--wait');

            expect(client.cloudHub2.getDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1');
            expect(mocks.spinner.succeed).toHaveBeenCalledWith('orders-sapi: STOPPED');
            expect(process.exitCode).toBeUndefined();
        });

        it('starts the app with setDesiredState', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(stoppedDetail());
            await run('start', 'orders-sapi', '--env', 'Sandbox');
            expect(client.cloudHub2.setDesiredState).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', 'STARTED');
        });
    });

    describe('restart', () => {
        it('shows the steps with --dry-run and writes nothing', async () => {
            await run('restart', 'orders-sapi', '--env', 'Sandbox', '--dry-run');

            expect(writes()).toBe(0);
            expect(mocks.log.dim).toHaveBeenCalledWith('  step: stop the application and wait until it is stopped');
            expect(mocks.log.dim).toHaveBeenCalledWith('  step: start the application');
        });

        it('stops, waits, then starts in one patch', async () => {
            await run('restart', 'orders-sapi', '--env', 'Sandbox', '--no-wait');

            expect(client.cloudHub2.setDesiredState).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', 'STOPPED');
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', {
                application: { desiredState: 'STARTED' },
            });
            expect(client.cloudHub2.setDesiredState.mock.invocationCallOrder[0]).toBeLessThan(
                client.cloudHub2.patchDeployment.mock.invocationCallOrder[0],
            );
            expect(process.exitCode).toBeUndefined();
        });
    });
});
