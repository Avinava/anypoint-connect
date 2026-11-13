import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAppDeployTools } from '../../../src/mcp/tools/apps-deploy.js';
import { registerAppLifecycleTools } from '../../../src/mcp/tools/apps-lifecycle.js';

const SERVICE = 'mule.agent.application.properties.service';

function detail(overrides: Record<string, unknown> = {}) {
    return {
        id: 'dep-1',
        name: 'orders-sapi',
        status: 'APPLIED',
        application: {
            desiredState: 'STARTED',
            ref: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' },
            configuration: {
                [SERVICE]: {
                    applicationName: 'orders-sapi',
                    properties: { 'http.port': '8081' },
                    secureProperties: {},
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
        ...overrides,
    };
}

describe('an apply is bound to the change that was reviewed', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = { registerTool: vi.fn((name: string, _d: unknown, h: any) => handlers.set(name, h)) };
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
        client.cloudHub2.patchDeployment.mock.calls.length + client.cloudHub2.setDesiredState.mock.calls.length;
    const args = { appName: 'orders-sapi', environment: 'Sandbox', version: '1.1.0', wait: false };

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-1',
            name: 'Sandbox',
            isProduction: false,
        });
        client.runtimes.getTarget.mockResolvedValue({
            id: 'cloudhub-us-east-2',
            runtimes: [{ version: '4.9.0', releaseChannel: 'LTS', java: ['17'] }],
        });
        client.cloudHub2.findDetailByName.mockResolvedValue(detail());
        client.cloudHub2.patchDeployment.mockResolvedValue(detail({ status: 'APPLYING', desiredVersion: 'spec-2' }));
        registerAppDeployTools(server as any, client as any);
        registerAppLifecycleTools(server as any, client as any);
    });

    async function preview(tool = 'update_app', input: Record<string, unknown> = args) {
        const body = parse(await handlers.get(tool)!(input));
        expect(body.dryRun).toBe(true);
        return body;
    }

    it('the preview names the digest the apply must carry', async () => {
        const body = await preview();
        expect(body.planDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(body.confirmation).toEqual({ confirm: true, planDigest: body.planDigest });
        expect(writes()).toBe(0);
    });

    it('refuses confirm without a planDigest, writing nothing', async () => {
        const result = await handlers.get('update_app')!({ ...args, confirm: true });
        expect(result.isError).toBe(true);
        expect(parse(result).message).toContain('planDigest is required');
        expect(writes()).toBe(0);
    });

    it('refuses a digest from a different change, writing nothing', async () => {
        const other = await preview('update_app', { ...args, version: '1.2.0' });
        const result = await handlers.get('update_app')!({ ...args, confirm: true, planDigest: other.planDigest });
        expect(result.isError).toBe(true);
        expect(parse(result).message).toContain('differs from the one you reviewed');
        expect(writes()).toBe(0);
    });

    it('refuses when the app changed after the preview, writing nothing', async () => {
        const body = await preview();
        client.cloudHub2.findDetailByName.mockResolvedValue(
            detail({ desiredVersion: 'spec-7', lastModifiedDate: 7_000 }),
        );
        const result = await handlers.get('update_app')!({ ...args, confirm: true, planDigest: body.planDigest });
        expect(result.isError).toBe(true);
        expect(writes()).toBe(0);
    });

    it('applies the reviewed change when the digest matches', async () => {
        const body = await preview();
        const result = await handlers.get('update_app')!({ ...args, confirm: true, planDigest: body.planDigest });
        expect(result.isError).toBeUndefined();
        expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
    });

    it('binds restart_app the same way', async () => {
        const restart = { appName: 'orders-sapi', environment: 'Sandbox' };
        const unbound = await handlers.get('restart_app')!({ ...restart, confirm: true });
        expect(unbound.isError).toBe(true);
        expect(writes()).toBe(0);
        const body = parse(await handlers.get('restart_app')!(restart));
        expect(body.planDigest).toBeDefined();
    });

    it('does not ask for a digest when creating a new app (nothing exists to bind to)', async () => {
        client.cloudHub2.findDetailByName.mockResolvedValue(null);
        const created = detail({ id: 'dep-new' });
        client.cloudHub2.createDeployment.mockResolvedValue(created);
        const result = await handlers.get('deploy_app')!({
            appName: 'brand-new',
            environment: 'Sandbox',
            groupId: 'org-1',
            artifactId: 'brand-new',
            version: '1.0.0',
            wait: false,
            confirm: true,
        });
        expect(result.isError).toBeUndefined();
        expect(client.cloudHub2.createDeployment).toHaveBeenCalledTimes(1);
    });
});
