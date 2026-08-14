import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApplicationTools } from '../../src/mcp/tools/applications.js';

describe('application MCP tools', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const detail = {
        id: 'dep-1',
        name: 'sample-app',
        status: 'APPLIED',
        application: {
            desiredState: 'STOPPED',
            ref: { groupId: 'org-1', artifactId: 'sample-app', version: '1.0.0', packaging: 'jar' },
            configuration: {
                'mule.agent.application.properties.service': {
                    applicationName: 'sample-app',
                    properties: { environment: 'test', unchanged: 'yes' },
                    secureProperties: { credential: '******' },
                },
            },
        },
        target: {
            provider: 'MC',
            targetId: 'private-space-1',
            deploymentSettings: { runtime: { version: '4.9.0' } },
            replicas: 1,
        },
        replicas: [{ state: 'STOPPED', deploymentLocation: 'private-space-1' }],
    };
    const client = {
        getDefaultOrgId: vi.fn().mockResolvedValue('org-1'),
        accessManagement: {
            resolveEnvironment: vi.fn().mockResolvedValue({ id: 'env-1', name: 'Test' }),
        },
        cloudHub2: {
            findDetailByName: vi.fn().mockResolvedValue(detail),
            updateApplicationConfiguration: vi.fn().mockResolvedValue({ id: 'dep-1', status: 'APPLYING' }),
        },
    };

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        registerApplicationTools(server as any, client as any);
    });

    it('merges settings from full detail and delegates to the narrow configuration API', async () => {
        const result = await handlers.get('update_app_settings')!({
            appName: 'sample-app',
            environment: 'Test',
            properties: { environment: 'staging' },
        });

        expect(client.cloudHub2.updateApplicationConfiguration).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1', {
            applicationName: 'sample-app',
            properties: { environment: 'staging', unchanged: 'yes' },
            secureProperties: { credential: '******' },
        });
        expect(result.isError).toBeUndefined();
    });

    it('rejects absent or empty settings without making an API request', async () => {
        const handler = handlers.get('update_app_settings')!;
        expect((await handler({ appName: 'sample-app', environment: 'Test' })).isError).toBe(true);
        expect(
            (await handler({ appName: 'sample-app', environment: 'Test', properties: {}, secureProperties: {} }))
                .isError,
        ).toBe(true);
        expect(client.cloudHub2.updateApplicationConfiguration).not.toHaveBeenCalled();
    });
});
