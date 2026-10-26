import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    discoverProjectConfig: vi.fn(),
    resolveJarArtifact: vi.fn(),
}));

vi.mock('../../../src/config/profiles.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/config/profiles.js')>()),
    discoverProjectConfig: mocks.discoverProjectConfig,
}));
vi.mock('../../../src/workflows/jar-deployment.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/workflows/jar-deployment.js')>()),
    resolveJarArtifact: mocks.resolveJarArtifact,
}));

import { registerAppReadTools } from '../../../src/mcp/tools/apps-read.js';

const SERVICE = 'mule.agent.application.properties.service';
const PLAIN_SECRET = 'plaintext-db-password-1';
const STORED_SECURE = 'stored-secure-value-should-not-appear';

function makeDetail(overrides: Record<string, any> = {}) {
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
                    properties: { 'http.port': '8081', 'db.password': PLAIN_SECRET },
                    secureProperties: { 'sf.token': STORED_SECURE },
                },
                'mule.agent.logging.service': { scopeLoggingConfigurations: [], apiToken: 'logging-token-value' },
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
        lastModifiedDate: Date.now() - 1_000,
        ...overrides,
    };
}

describe('application read MCP tools', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        runtimes: { getTarget: vi.fn(), getTargets: vi.fn() },
        cloudHub2: { findDetailByName: vi.fn(), getDeployment: vi.fn() },
    };
    const parse = (result: any) => JSON.parse(result.content[0].text);

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Sandbox' });
        client.cloudHub2.findDetailByName.mockResolvedValue(makeDetail());
        client.runtimes.getTarget.mockResolvedValue({
            id: 'cloudhub-us-east-2',
            name: 'US East (Ohio)',
            runtimes: [
                { version: '4.9.0', releaseChannel: 'LTS', java: ['17'] },
                { version: '4.10.1', releaseChannel: 'EDGE', java: ['17'] },
            ],
        });
        mocks.discoverProjectConfig.mockReturnValue(null);
        registerAppReadTools(server as any, client as any);
    });

    describe('get_app_status', () => {
        it('reports phase and settled for a running app', async () => {
            const body = parse(
                await handlers.get('get_app_status')!({ appName: 'orders-sapi', environment: 'Sandbox' }),
            );
            expect(body).toMatchObject({ name: 'orders-sapi', phase: 'RUNNING', settled: true, status: 'APPLIED' });
            expect(body.replicas).toEqual([{ id: 'r1', state: 'STARTED', onCurrentSpec: true }]);
        });

        it('reports a fresh platform FAILED during start-up as STARTING', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(
                makeDetail({ status: 'FAILED', replicas: [{ id: 'r1', state: 'PENDING' }] }),
            );
            const body = parse(
                await handlers.get('get_app_status')!({ appName: 'orders-sapi', environment: 'Sandbox' }),
            );
            expect(body).toMatchObject({ phase: 'STARTING', settled: false, status: 'FAILED' });
            expect(body.reason).toBe('replicas still starting; failure not yet confirmed');
        });

        it('waits until the app settles when asked', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(
                makeDetail({ status: 'APPLYING', replicas: [{ id: 'r1', state: 'PENDING' }] }),
            );
            client.cloudHub2.getDeployment.mockResolvedValue(makeDetail());
            const body = parse(
                await handlers.get('get_app_status')!({ appName: 'orders-sapi', environment: 'Sandbox', wait: true }),
            );
            expect(client.cloudHub2.getDeployment).toHaveBeenCalledWith('org-1', 'env-1', 'dep-1');
            expect(body).toMatchObject({ phase: 'RUNNING', settled: true });
        });
    });

    describe('get_app_settings', () => {
        it('masks secret-looking plain values, warns, and never returns secure values', async () => {
            const result = await handlers.get('get_app_settings')!({ appName: 'orders-sapi', environment: 'Sandbox' });
            const body = parse(result);

            expect(body.properties['http.port']).toBe('8081');
            expect(body.properties['db.password']).toBe('******…-1');
            expect(body.securePropertyKeys).toEqual(['sf.token']);
            expect(body.warnings).toEqual([
                {
                    key: 'db.password',
                    issue: 'secret-like key stored as a plain property',
                    fix: 'update_app_settings with moveToSecure: ["db.password"]',
                },
            ]);
            expect(body.otherConfiguration['mule.agent.logging.service'].apiToken).toBe('******…ue');
            expect(body.rawConfiguration).toBeUndefined();
            expect(result.content[0].text).not.toContain(PLAIN_SECRET);
            expect(result.content[0].text).not.toContain(STORED_SECURE);
            expect(result.content[0].text).not.toContain('logging-token-value');
        });

        it('shows plain values with redact: false, still with warnings and without secure values', async () => {
            const result = await handlers.get('get_app_settings')!({
                appName: 'orders-sapi',
                environment: 'Sandbox',
                redact: false,
            });
            const body = parse(result);

            expect(body.properties['db.password']).toBe(PLAIN_SECRET);
            expect(body.warnings).toHaveLength(1);
            expect(result.content[0].text).not.toContain(STORED_SECURE);
        });

        it('omits warnings when no plain key looks secret', async () => {
            const base = makeDetail();
            const detail = {
                ...base,
                application: {
                    ...base.application,
                    configuration: {
                        [SERVICE]: { applicationName: 'orders-sapi', properties: { 'http.port': '8081' } },
                    },
                },
            };
            client.cloudHub2.findDetailByName.mockResolvedValue(detail);
            const body = parse(
                await handlers.get('get_app_settings')!({ appName: 'orders-sapi', environment: 'Sandbox' }),
            );
            expect(body.warnings).toBeUndefined();
            expect(body.securePropertyKeys).toEqual([]);
            expect(body.otherConfiguration).toBeUndefined();
        });
    });

    describe('list_runtime_versions', () => {
        it('flags an app on a retired runtime with suggestions', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(
                makeDetail({
                    target: {
                        provider: 'MC',
                        targetId: 'cloudhub-us-east-2',
                        deploymentSettings: { runtime: { version: '4.8.5:4e-java8' } },
                        replicas: 1,
                    },
                }),
            );
            const body = parse(
                await handlers.get('list_runtime_versions')!({ environment: 'Sandbox', appName: 'orders-sapi' }),
            );

            expect(client.runtimes.getTarget).toHaveBeenCalledWith('org-1', 'cloudhub-us-east-2');
            expect(body.current).toMatchObject({ version: '4.8.5', java: '8', supported: false });
            expect(body.suggestions).toEqual(['4.9.0 LTS java17', '4.10.1 EDGE java17']);
            expect(body.versions.map((v: { version: string }) => v.version)).toEqual(['4.10.1', '4.9.0']);
        });

        it('reports a supported runtime without suggestions', async () => {
            const body = parse(
                await handlers.get('list_runtime_versions')!({ environment: 'Sandbox', appName: 'orders-sapi' }),
            );
            expect(body.current.supported).toBe(true);
            expect(body.suggestions).toBeUndefined();
        });

        it('lists targets when neither app nor target is given', async () => {
            client.runtimes.getTargets.mockResolvedValue([
                {
                    id: 'cloudhub-us-east-2',
                    name: 'US East',
                    type: 'shared',
                    runtimes: [{ version: '4.9.0', java: [] }],
                },
            ]);
            const body = parse(await handlers.get('list_runtime_versions')!({ environment: 'Sandbox' }));
            expect(body.targets).toEqual([{ id: 'cloudhub-us-east-2', name: 'US East', type: 'shared', versions: 1 }]);
        });
    });

    describe('suggest_asset_name', () => {
        const timestamped = () =>
            makeDetail({
                application: {
                    desiredState: 'STARTED',
                    ref: {
                        groupId: 'org-1',
                        artifactId: 'orders-sapi-1.4.0-20260101120000',
                        version: '1.0.0',
                        packaging: 'jar',
                    },
                },
            });

        it('reports the deployed pattern and applies it to the JAR', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(timestamped());
            mocks.resolveJarArtifact.mockResolvedValue({
                artifact: { coordinates: { groupId: 'com.example', artifactId: 'orders-sapi', version: '1.5.0' } },
            });
            const body = parse(
                await handlers.get('suggest_asset_name')!({
                    appName: 'orders-sapi',
                    environment: 'Sandbox',
                    jarPath: 'target/orders-sapi-1.5.0-mule-application.jar',
                }),
            );

            expect(body.deployedPattern).toEqual({ assetId: '{app}-{pomVersion}-{timestamp}', assetVersion: '1.0.0' });
            expect(body.suggestion).toMatchObject({
                groupId: 'org-1',
                version: '1.0.0',
                rules: { assetId: 'inferred', version: 'inferred', groupId: 'organization' },
            });
            expect(body.suggestion.assetId).toMatch(/^orders-sapi-1\.5\.0-\d{14}$/);
            expect(body.tip).toContain('"conventions"');
        });

        it('prefers the project convention', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(timestamped());
            mocks.discoverProjectConfig.mockReturnValue({ conventions: { assetId: '{app}', assetVersion: '2.0.0' } });
            const body = parse(
                await handlers.get('suggest_asset_name')!({ appName: 'orders-sapi', environment: 'Sandbox' }),
            );
            expect(body.suggestion).toMatchObject({ assetId: 'orders-sapi', version: '2.0.0' });
            expect(body.projectConvention).toEqual({ assetId: '{app}', assetVersion: '2.0.0' });
            expect(body.tip).toBeUndefined();
        });

        // Without jarPath the inferred pattern cannot be filled; the pattern is still reported.
        it('reports the deployed pattern without a JAR', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(timestamped());
            const result = await handlers.get('suggest_asset_name')!({
                appName: 'orders-sapi',
                environment: 'Sandbox',
            });
            expect(result.isError).toBeUndefined();
            expect(parse(result).deployedPattern).toEqual({
                assetId: '{app}-{pomVersion}-{timestamp}',
                assetVersion: '1.0.0',
            });
            expect(parse(result).suggestion).toBeNull();
            expect(parse(result).unresolved).toContain('jarPath');
        });
    });
});
