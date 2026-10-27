import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), header: vi.fn(), kv: vi.fn(), dim: vi.fn() },
    printTable: vi.fn(),
}));
vi.mock('../../src/commands/shared.js', () => ({ createClient: mocks.createClient }));
vi.mock('../../src/utils/logger.js', () => ({ log: mocks.log }));
vi.mock('../../src/utils/formatter.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/formatter.js')>()),
    printTable: mocks.printTable,
}));

import { createAlertsCommand } from '../../src/commands/alerts.js';
import { ORG, PRODUCTION, SANDBOX, appAlert, deployment } from '../fixtures/alerts.js';

describe('anc alerts', () => {
    const alerts = {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        listRuntimeManager: vi.fn(),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        whoami: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        cloudHub2: { findDetailByName: vi.fn() },
        alerts,
    };
    const run = (...args: string[]) => createAlertsCommand().parseAsync(['node', 'alerts', ...args]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    beforeEach(() => {
        vi.clearAllMocks();
        process.exitCode = undefined;
        mocks.createClient.mockReturnValue(client);
        client.getDefaultOrgId.mockResolvedValue(ORG);
        client.whoami.mockResolvedValue({ email: 'someone@example.com' });
        client.accessManagement.resolveEnvironment.mockResolvedValue(SANDBOX);
        client.cloudHub2.findDetailByName.mockResolvedValue(deployment);
        alerts.list.mockResolvedValue([appAlert()]);
        alerts.get.mockResolvedValue(appAlert());
        alerts.create.mockResolvedValue({ id: 'alert-new' });
    });

    it('lists alerts with recipients masked', async () => {
        await run('list', '--source', 'monitoring');
        const rows = mocks.printTable.mock.calls[0][1];
        expect(rows[0]).toEqual(expect.arrayContaining(['alert-1', 'orders memory', '2']));
        expect(JSON.stringify(rows)).not.toContain('ops@example.com');
    });

    const create = [
        'create',
        '-e',
        'Sandbox',
        '--name',
        'orders cpu',
        '--app',
        'orders-sapi',
        '--metric',
        'cpu_utilization',
        '--operator',
        'GREATER_THAN',
        '--threshold',
        '90',
        '--duration',
        '5',
        '--severity',
        '1',
        '--email',
        'ops@example.com',
        '--subject',
        'CPU',
        '--message',
        'CPU high',
    ];

    it('create --dry-run prints the payload and creates nothing', async () => {
        await run(...create, '--dry-run');
        expect(alerts.create).not.toHaveBeenCalled();
        expect(mocks.log.info).toHaveBeenCalledWith('Dry run: nothing was created.');
    });

    it('create sends the converted payload', async () => {
        await run(...create);
        expect(alerts.create.mock.calls[0][1].settings.threshold).toBe(0.9);
        expect(alerts.create.mock.calls[0][1].enabled).toBe(false);
    });

    it('delete is a dry run until --confirm matches, and production needs --allow-production', async () => {
        await run('delete', 'alert-1');
        expect(alerts.delete).not.toHaveBeenCalled();

        client.accessManagement.resolveEnvironment.mockResolvedValue(PRODUCTION);
        await run('delete', 'alert-1', '--confirm', 'orders memory');
        expect(alerts.delete).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);

        alerts.get.mockResolvedValueOnce(appAlert()).mockResolvedValueOnce(appAlert({ alertStatus: 'PENDING' }));
        await run('delete', 'alert-1', '--confirm', 'orders memory', '--allow-production');
        expect(alerts.delete).toHaveBeenCalledWith(ORG, 'alert-1');
        expect(mocks.log.success).not.toHaveBeenCalled();
    });
});
