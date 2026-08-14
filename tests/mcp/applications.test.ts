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
            deleteDeployment: vi.fn().mockResolvedValue(undefined),
            waitForDeploymentDeletion: vi.fn().mockResolvedValue({ verifiedAbsent: true }),
        },
    };

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Test' });
        client.cloudHub2.findDetailByName.mockResolvedValue(detail);
        client.cloudHub2.deleteDeployment.mockResolvedValue(undefined);
        client.cloudHub2.waitForDeploymentDeletion.mockResolvedValue({ verifiedAbsent: true });
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

    it('previews application deletion without making a DELETE request', async () => {
        const result = await handlers.get('delete_app')!({
            appName: 'sample-app',
            environment: 'Test',
        });
        const payload = JSON.parse(result.content[0].text);

        expect(payload.dryRun).toBe(true);
        expect(payload.deploymentId).toBe('dep-1');
        expect(payload.confirmation).toEqual({ confirm: true, expectedDeploymentId: 'dep-1' });
        expect(client.cloudHub2.deleteDeployment).not.toHaveBeenCalled();
    });

    it('deletes only when confirmation is bound to the current deployment ID', async () => {
        const result = await handlers.get('delete_app')!({
            appName: 'sample-app',
            environment: 'Test',
            confirm: true,
            expectedDeploymentId: 'dep-1',
        });
        const payload = JSON.parse(result.content[0].text);

        expect(client.cloudHub2.deleteDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1');
        expect(client.cloudHub2.waitForDeploymentDeletion).toHaveBeenCalledWith(
            'org-1',
            'env-1',
            'sample-app',
            'dep-1',
        );
        expect(payload).toMatchObject({ deleted: true, verifiedAbsent: true, deploymentId: 'dep-1' });
    });

    it('refuses a missing or stale deployment confirmation ID', async () => {
        const handler = handlers.get('delete_app')!;
        const missing = await handler({ appName: 'sample-app', environment: 'Test', confirm: true });
        const stale = await handler({
            appName: 'sample-app',
            environment: 'Test',
            confirm: true,
            expectedDeploymentId: 'dep-old',
        });

        expect(missing.isError).toBe(true);
        expect(stale.isError).toBe(true);
        expect(client.cloudHub2.deleteDeployment).not.toHaveBeenCalled();
    });

    it('requires an additional production acknowledgement', async () => {
        client.accessManagement.resolveEnvironment.mockResolvedValueOnce({
            id: 'env-prod',
            name: 'Production',
            isProduction: true,
        });
        const refused = await handlers.get('delete_app')!({
            appName: 'sample-app',
            environment: 'Production',
            confirm: true,
            expectedDeploymentId: 'dep-1',
        });

        expect(refused.isError).toBe(true);
        expect(client.cloudHub2.deleteDeployment).not.toHaveBeenCalled();

        client.accessManagement.resolveEnvironment.mockResolvedValueOnce({
            id: 'env-prod',
            name: 'Production',
            isProduction: true,
        });
        await handlers.get('delete_app')!({
            appName: 'sample-app',
            environment: 'Production',
            confirm: true,
            expectedDeploymentId: 'dep-1',
            confirmProduction: true,
        });

        expect(client.cloudHub2.deleteDeployment).toHaveBeenCalledWith('org-1', 'env-prod', 'dep-1');
    });

    it('treats a confirmed retry as already absent', async () => {
        client.cloudHub2.findDetailByName.mockResolvedValueOnce(null);

        const result = await handlers.get('delete_app')!({
            appName: 'sample-app',
            environment: 'Test',
            confirm: true,
            expectedDeploymentId: 'dep-1',
        });
        const payload = JSON.parse(result.content[0].text);

        expect(payload).toMatchObject({ alreadyAbsent: true, verifiedAbsent: true });
        expect(client.cloudHub2.deleteDeployment).not.toHaveBeenCalled();
    });

    it('reports replacement detection and verification timeout without deleting the replacement', async () => {
        client.cloudHub2.waitForDeploymentDeletion.mockResolvedValueOnce({
            verifiedAbsent: false,
            replacementDeploymentId: 'dep-2',
        });
        const replacement = await handlers.get('delete_app')!({
            appName: 'sample-app',
            environment: 'Test',
            confirm: true,
            expectedDeploymentId: 'dep-1',
        });
        expect(replacement.isError).toBe(true);
        expect(JSON.parse(replacement.content[0].text)).toMatchObject({
            replacementDetected: true,
            replacementDeploymentId: 'dep-2',
        });

        client.cloudHub2.waitForDeploymentDeletion.mockResolvedValueOnce({
            verifiedAbsent: false,
            deletionState: 'DELETED',
            currentDeploymentId: 'dep-1',
        });
        const pending = await handlers.get('delete_app')!({
            appName: 'sample-app',
            environment: 'Test',
            confirm: true,
            expectedDeploymentId: 'dep-1',
        });
        expect(pending.isError).toBeUndefined();
        expect(JSON.parse(pending.content[0].text)).toMatchObject({
            deletionAccepted: true,
            verifiedAbsent: false,
            deletionState: 'DELETED',
        });
        expect(client.cloudHub2.deleteDeployment).toHaveBeenCalledTimes(2);
    });

    it('returns an MCP error when CloudHub rejects deletion', async () => {
        client.cloudHub2.deleteDeployment.mockRejectedValueOnce(new Error('delete rejected'));

        const result = await handlers.get('delete_app')!({
            appName: 'sample-app',
            environment: 'Test',
            confirm: true,
            expectedDeploymentId: 'dep-1',
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('delete rejected');
        expect(client.cloudHub2.waitForDeploymentDeletion).not.toHaveBeenCalled();
    });
});
