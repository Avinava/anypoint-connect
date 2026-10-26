import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAppLifecycleTools } from '../../../src/mcp/tools/apps-lifecycle.js';

/** Every lifecycle write previews without confirm and needs confirmProduction in production. */
describe('lifecycle write guard', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const running = {
        id: 'dep-1',
        name: 'orders-sapi',
        status: 'APPLIED',
        desiredVersion: 'spec-1',
        application: {
            desiredState: 'STARTED',
            ref: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' },
        },
        target: { provider: 'MC', targetId: 'cloudhub-us-east-2', deploymentSettings: {}, replicas: 1 },
        replicas: [{ state: 'STARTED', currentDeploymentVersion: 'spec-1' }],
    };
    const client = {
        getDefaultOrgId: vi.fn().mockResolvedValue('org-1'),
        accessManagement: { resolveEnvironment: vi.fn() },
        runtimes: { getTarget: vi.fn().mockResolvedValue(null) },
        cloudHub2: {
            findDetailByName: vi.fn(),
            setDesiredState: vi.fn().mockResolvedValue({ id: 'dep-1' }),
            scaleApp: vi.fn().mockResolvedValue({ id: 'dep-1' }),
            patchDeployment: vi.fn().mockResolvedValue({ id: 'dep-1' }),
            getDeployment: vi.fn(),
        },
    };

    const writes = () => [
        client.cloudHub2.setDesiredState,
        client.cloudHub2.scaleApp,
        client.cloudHub2.patchDeployment,
    ];

    const cases: Array<[string, Record<string, unknown>, () => unknown]> = [
        ['scale_app', { replicas: 2 }, () => client.cloudHub2.scaleApp],
        ['stop_app', {}, () => client.cloudHub2.setDesiredState],
        ['restart_app', {}, () => client.cloudHub2.setDesiredState],
    ];

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        client.cloudHub2.findDetailByName.mockResolvedValue(running);
        registerAppLifecycleTools(server as any, client as any);
    });

    it.each(cases)('%s previews without confirm', async (name, extra) => {
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Sandbox' });
        const result = await handlers.get(name)!({ appName: 'orders-sapi', environment: 'Sandbox', ...extra });
        expect(JSON.parse(result.content[0].text).dryRun).toBe(true);
        for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });

    it.each(cases)('%s refuses production without confirmProduction', async (name, extra, write) => {
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-1',
            name: 'Production',
            isProduction: true,
        });
        const refused = await handlers.get(name)!({
            appName: 'orders-sapi',
            environment: 'Production',
            confirm: true,
            ...extra,
        });
        expect(refused.isError).toBe(true);
        for (const w of writes()) expect(w).not.toHaveBeenCalled();

        const preview = JSON.parse(
            (await handlers.get(name)!({ appName: 'orders-sapi', environment: 'Production', ...extra })).content[0]
                .text,
        );
        expect(preview.production).toBe(true);

        client.cloudHub2.getDeployment.mockResolvedValue({
            ...running,
            application: { ...running.application, desiredState: 'STOPPED' },
            replicas: [],
        });
        await handlers.get(name)!({
            appName: 'orders-sapi',
            environment: 'Production',
            confirm: true,
            confirmProduction: true,
            ...extra,
        });
        expect(write()).toHaveBeenCalled();
    });

    it('start_app reports a running app as nothing to do', async () => {
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Sandbox' });
        const result = await handlers.get('start_app')!({
            appName: 'orders-sapi',
            environment: 'Sandbox',
            confirm: true,
        });
        expect(JSON.parse(result.content[0].text).noop).toBe(true);
        expect(client.cloudHub2.setDesiredState).not.toHaveBeenCalled();
    });
});
