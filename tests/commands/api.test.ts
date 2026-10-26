import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    confirmAction: vi.fn(),
    executeSmokeTest: vi.fn(),
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
}));

vi.mock('../../src/commands/shared.js', () => ({
    createClient: mocks.createClient,
    confirmAction: mocks.confirmAction,
}));
vi.mock('../../src/utils/logger.js', () => ({ log: mocks.log }));
vi.mock('../../src/utils/formatter.js', () => ({ printTable: mocks.printTable }));
vi.mock('../../src/client/smoke-test.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/client/smoke-test.js')>()),
    executeSmokeTest: mocks.executeSmokeTest,
}));

import { createApiCommand } from '../../src/commands/api.js';
import { PROJECT_ROOT_ENV } from '../../src/safety/paths.js';

const SECRET = 'S3cr3tValue-9f8e7d6c5b4a';

describe('api CLI', () => {
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        apiManager: {
            resolveApiInstance: vi.fn(),
            getContracts: vi.fn(),
            getClientApplication: vi.fn(),
            getPolicies: vi.fn(),
        },
    };
    const run = (...args: string[]) => createApiCommand().parseAsync(['node', 'api', ...args]);
    const allOutput = () =>
        JSON.stringify([
            ...Object.values(mocks.log).map((fn) => fn.mock.calls),
            mocks.printTable.mock.calls,
            (console.log as any).mock?.calls,
        ]);
    let root: string;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        process.exitCode = undefined;
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-cli-api-')));
        process.env[PROJECT_ROOT_ENV] = root;
        mocks.createClient.mockReturnValue(client);
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-1',
            name: 'Sandbox',
            isProduction: false,
        });
        client.apiManager.resolveApiInstance.mockResolvedValue({
            apiId: 42,
            asset: { exchangeAssetName: 'orders-sapi' },
            instance: { id: 42, endpointUri: 'https://orders.example.com/api' },
        });
        client.apiManager.getPolicies.mockResolvedValue([]);
        client.apiManager.getContracts.mockResolvedValue([
            { id: 5, status: 'APPROVED', application: { id: 7, name: 'orders-client' }, tier: { id: 1, name: 'Gold' } },
        ]);
        client.apiManager.getClientApplication.mockResolvedValue({
            id: 7,
            name: 'orders-client',
            clientId: 'client-id-1',
            clientSecret: SECRET,
        });
        mocks.executeSmokeTest.mockResolvedValue({
            api: { id: 42 },
            request: { method: 'GET', url: 'https://orders.example.com/api', credentials: 'none' },
            status: 200,
            statusText: 'OK',
            latencyMs: 12,
            passed: true,
            headers: {},
            body: { excerpt: '', truncated: false },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env[PROJECT_ROOT_ENV];
        fs.rmSync(root, { recursive: true, force: true });
        process.exitCode = undefined;
    });

    it('lists contracts', async () => {
        await run('contracts', 'orders', '-e', 'Sandbox');
        expect(client.apiManager.getContracts).toHaveBeenCalledWith('org-1', 'env-1', 42);
        expect(mocks.printTable).toHaveBeenCalledWith(
            ['Contract ID', 'Client App', 'App ID', 'Tier', 'Status'],
            [['5', 'orders-client', '7', 'Gold', 'APPROVED']],
        );
    });

    it('shows a client app with the secret masked and writes a 0600 credentials file', async () => {
        await run('client-app', '7', '--write-credentials', 'client.env');
        expect(mocks.log.kv).toHaveBeenCalledWith('Client secret', `******…${SECRET.slice(-4)}`);
        expect(allOutput()).not.toContain(SECRET);
        const file = path.join(root, 'client.env');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);

        await run('client-app', '7', '--write-credentials', 'client.env');
        expect(process.exitCode).toBe(1);
        expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining('File exists'));
        expect(allOutput()).not.toContain(SECRET);
    });

    it('runs GET smoke tests without a prompt', async () => {
        await run('smoke', 'orders', '-e', 'Sandbox', '--path', '/orders');
        expect(mocks.confirmAction).not.toHaveBeenCalled();
        expect(mocks.executeSmokeTest).toHaveBeenCalledWith(
            client,
            'org-1',
            expect.objectContaining({ method: 'GET', url: 'https://orders.example.com/api/orders' }),
            expect.anything(),
        );
        expect(mocks.log.success).toHaveBeenCalledWith('Passed');
    });

    it('asks before a non-GET request and stops when declined', async () => {
        mocks.confirmAction.mockResolvedValue(false);
        await run('smoke', 'orders', '-e', 'Sandbox', '--path', '/orders', '-X', 'POST', '-d', '{}');
        expect(mocks.confirmAction).toHaveBeenCalledWith('Send POST https://orders.example.com/api/orders?');
        expect(mocks.executeSmokeTest).not.toHaveBeenCalled();

        await run('smoke', 'orders', '-e', 'Sandbox', '--path', '/orders', '-X', 'POST', '--yes');
        expect(mocks.executeSmokeTest).toHaveBeenCalledTimes(1);
    });

    it('refuses a non-GET request in production without --allow-production', async () => {
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-1',
            name: 'Production',
            isProduction: true,
        });
        await run('smoke', 'orders', '-e', 'Production', '-X', 'DELETE', '--yes');
        expect(mocks.executeSmokeTest).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
    });

    it('passes --expect through and fails when the status does not match', async () => {
        mocks.executeSmokeTest.mockResolvedValue({
            api: { id: 42 },
            request: { method: 'GET', url: 'https://orders.example.com/api', credentials: 'none' },
            status: 200,
            statusText: 'OK',
            latencyMs: 12,
            passed: false,
            expectStatus: 201,
            headers: {},
            body: { excerpt: '', truncated: false },
        });
        await run('smoke', 'orders', '-e', 'Sandbox', '--expect', '201');
        expect(mocks.executeSmokeTest).toHaveBeenCalledWith(
            client,
            'org-1',
            expect.anything(),
            expect.objectContaining({ expectStatus: 201 }),
        );
        expect(mocks.log.error).toHaveBeenCalledWith('Expected 201, got 200');
        expect(process.exitCode).toBe(1);
    });
});
