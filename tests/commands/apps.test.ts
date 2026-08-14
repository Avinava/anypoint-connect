import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    },
}));

vi.mock('../../src/commands/shared.js', () => ({ createClient: mocks.createClient }));
vi.mock('../../src/utils/logger.js', () => ({ log: mocks.log }));

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
});
