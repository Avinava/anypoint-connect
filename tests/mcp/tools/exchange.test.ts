import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeApi } from '../../../src/api/ExchangeApi.js';
import { registerAppDeployTools } from '../../../src/mcp/tools/apps-deploy.js';
import { registerExchangeTools } from '../../../src/mcp/tools/exchange.js';
import { saveUnmarkedAllowance } from '../../../src/safety/preapproval.js';

describe('artifact publication handoff', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) =>
            handlers.set(name, handler),
        ),
    };
    const client = {
        getDefaultOrgId: vi.fn().mockResolvedValue('sample-org'),
        accessManagement: { resolveEnvironment: vi.fn().mockResolvedValue({ id: 'sample-env', name: 'Test' }) },
        cloudHub2: {
            findDetailByName: vi.fn().mockResolvedValue(null),
            createDeployment: vi.fn(),
            updateArtifactRef: vi.fn(),
            patchDeployment: vi.fn(),
        },
        exchange: { publishAppAsset: vi.fn() },
        runtimes: { getTarget: vi.fn().mockResolvedValue(null) },
    };
    let root: string;
    let jarPath: string;
    beforeEach(() => {
        vi.clearAllMocks();
        client.getDefaultOrgId.mockReset().mockResolvedValue('sample-org');
        client.cloudHub2.findDetailByName.mockReset().mockResolvedValue(null);
        client.exchange.publishAppAsset
            .mockReset()
            .mockResolvedValue({ groupId: 'sample-org', assetId: 'sample', version: '2.4.1' });
        client.cloudHub2.createDeployment.mockReset().mockResolvedValue({ id: 'sample-deployment', status: 'STARTED' });
        client.cloudHub2.patchDeployment.mockReset().mockResolvedValue({ id: 'sample-deployment', status: 'APPLYING' });
        client.cloudHub2.updateArtifactRef
            .mockReset()
            .mockResolvedValue({ id: 'sample-deployment', status: 'STARTED' });
        root = mkdtempSync(join(tmpdir(), 'publication-test-'));
        jarPath = join(root, 'display-label-2026-01-01.jar');
        writeFileSync(
            jarPath,
            zipSync({
                'META-INF/maven/dev.sample/sample/pom.properties': strToU8(
                    'groupId=dev.sample\nartifactId=sample\nversion=2.4.1\n',
                ),
            }),
        );
        registerExchangeTools(server as any, client as any);
        registerAppDeployTools(server as any, client as any);
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it.each(['publish_app_jar', 'deploy_jar'])(
        'uses embedded identity in %s preview without mutation',
        async (name) => {
            const result = await handlers.get(name)!({ jarPath, appName: 'sample', environment: 'Test' });
            const payload = JSON.parse(result.content[0].text);
            expect(payload.dryRun).toBe(true);
            expect(payload.artifact.coordinates).toEqual({
                groupId: 'dev.sample',
                artifactId: 'sample',
                version: '2.4.1',
            });
            expect(payload.coordinates ?? payload.publish).toMatchObject({
                groupId: 'sample-org',
                assetId: 'sample',
                version: '2.4.1',
            });
            expect(payload.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
            expect(client.exchange.publishAppAsset).not.toHaveBeenCalled();
            expect(client.cloudHub2.createDeployment).not.toHaveBeenCalled();
        },
    );

    it('preserves explicit Exchange coordinate mappings and passes the reviewed digest to upload', async () => {
        const handler = handlers.get('publish_app_jar')!;
        const preview = JSON.parse(
            (await handler({ jarPath, assetId: 'mapped', assetVersion: '3.0.0', groupId: 'mapped-group' })).content[0]
                .text,
        );
        expect(preview.coordinates).toMatchObject({ assetId: 'mapped', version: '3.0.0', groupId: 'mapped-group' });
        client.exchange.publishAppAsset.mockResolvedValue({
            groupId: 'mapped-group',
            assetId: 'mapped',
            version: '3.0.0',
        });
        await handler({
            jarPath,
            assetId: 'mapped',
            assetVersion: '3.0.0',
            groupId: 'mapped-group',
            confirm: true,
            expectedSha256: preview.expectedSha256,
        });
        expect(client.exchange.publishAppAsset).toHaveBeenCalledWith(
            'sample-org',
            'mapped-group',
            'mapped',
            '3.0.0',
            jarPath,
            preview.expectedSha256,
        );
    });

    it.each(['publish_app_jar', 'deploy_jar'])('rejects changed bytes before %s mutation', async (name) => {
        const result = await handlers.get(name)!({
            jarPath,
            appName: 'sample',
            environment: 'Test',
            confirm: true,
            expectedSha256: '0'.repeat(64),
        });
        expect(result.isError).toBe(true);
        expect(client.exchange.publishAppAsset).not.toHaveBeenCalled();
    });

    it.each(['publish_app_jar', 'deploy_jar'])(
        'accepts fully explicit mappings for ambiguous metadata in %s',
        async (name) => {
            writeFileSync(
                jarPath,
                zipSync({
                    'META-INF/maven/dev.sample/sample/pom.properties': strToU8(
                        'groupId=dev.sample\nartifactId=sample\nversion=2.4.1\n',
                    ),
                    'META-INF/maven/dev.sample/dependency/pom.properties': strToU8(
                        'groupId=dev.sample\nartifactId=dependency\nversion=1.0.0\n',
                    ),
                }),
            );
            const handler = handlers.get(name)!;
            const input = { jarPath, appName: 'sample', environment: 'Test' };
            expect((await handler(input)).isError).toBe(true);
            expect((await handler({ ...input, assetId: 'mapped' })).isError).toBe(true);
            const result = await handler({ ...input, assetId: 'mapped', assetVersion: '3.0.0' });
            const preview = JSON.parse(result.content[0].text);
            expect(preview.coordinates ?? preview.publish).toMatchObject({ assetId: 'mapped', version: '3.0.0' });
            expect(preview.artifact.coordinates).toBeUndefined();
            expect(client.exchange.publishAppAsset).not.toHaveBeenCalled();
        },
    );

    it.each(['publish_app_jar', 'deploy_jar'])('rejects an artifact modified after the %s preview', async (name) => {
        const handler = handlers.get(name)!;
        const input = { jarPath, appName: 'sample', environment: 'Test' };
        const preview = JSON.parse((await handler(input)).content[0].text);
        writeFileSync(
            jarPath,
            zipSync({
                'META-INF/maven/dev.sample/sample/pom.properties': strToU8(
                    'groupId=dev.sample\nartifactId=sample\nversion=2.4.2\n',
                ),
            }),
        );
        expect((await handler({ ...input, confirm: true, expectedSha256: preview.expectedSha256 })).isError).toBe(true);
        expect(client.exchange.publishAppAsset).not.toHaveBeenCalled();
    });

    it.each(['publish_app_jar', 'deploy_jar'])(
        'rechecks the exact upload bytes after %s resolves identity',
        async (name) => {
            const postMultipart = vi.fn();
            const api = new ExchangeApi({ postMultipart } as any, { delete: vi.fn() } as any);
            client.exchange.publishAppAsset.mockImplementation(
                async (...args: Parameters<ExchangeApi['publishAppAsset']>) => {
                    writeFileSync(jarPath, zipSync({ 'META-INF/MANIFEST.MF': strToU8('Changed after inspection') }));
                    return api.publishAppAsset(...args);
                },
            );
            const result = await handlers.get(name)!({
                jarPath,
                appName: 'sample',
                environment: 'Test',
                confirm: true,
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('digest changed');
            expect(postMultipart).not.toHaveBeenCalled();
            expect(client.cloudHub2.createDeployment).not.toHaveBeenCalled();
            expect(client.cloudHub2.updateArtifactRef).not.toHaveBeenCalled();
        },
    );

    it('preserves existing infrastructure when publishing and updating an artifact', async () => {
        const existing = {
            id: 'sample-deployment',
            application: { ref: { groupId: 'sample-org', artifactId: 'sample', version: '1.0.0', packaging: 'jar' } },
            target: { replicas: 3, targetId: 'sample-space' },
        };
        client.cloudHub2.findDetailByName.mockResolvedValue(existing as any);
        const result = await handlers.get('deploy_jar')!({
            jarPath,
            appName: 'sample',
            environment: 'Test',
            confirm: true,
        });
        expect(result.isError).not.toBe(true);
        expect(client.cloudHub2.patchDeployment).toHaveBeenCalledWith('sample-org', 'sample-env', 'sample-deployment', {
            application: { ref: { groupId: 'sample-org', artifactId: 'sample', version: '2.4.1', packaging: 'jar' } },
        });
        expect(existing.target).toEqual({ replicas: 3, targetId: 'sample-space' });
        expect(client.cloudHub2.createDeployment).not.toHaveBeenCalled();
    });

    it('rejects create-only options before publishing for an existing app', async () => {
        client.cloudHub2.findDetailByName.mockResolvedValue({ id: 'sample-deployment' } as any);
        await handlers.get('deploy_jar')!({
            jarPath,
            appName: 'sample',
            environment: 'Test',
            replicas: 2,
            confirm: true,
        });
        expect(client.exchange.publishAppAsset).not.toHaveBeenCalled();
        expect(client.cloudHub2.patchDeployment).not.toHaveBeenCalled();
    });

    it.each(['publish_app_jar', 'deploy_jar'])('does not bypass authorization in %s', async (name) => {
        client.getDefaultOrgId.mockRejectedValue(new Error('Authentication required'));
        const result = await handlers.get(name)!({ jarPath, appName: 'sample', environment: 'Test', confirm: true });
        expect(result.isError).toBe(true);
        expect(client.exchange.publishAppAsset).not.toHaveBeenCalled();
        expect(client.cloudHub2.createDeployment).not.toHaveBeenCalled();
    });

    describe('build provenance', () => {
        const production = { id: 'prod-env', name: 'Production', isProduction: true };
        const marker = (productionDeployable: boolean) =>
            strToU8(
                JSON.stringify({
                    schemaVersion: 1,
                    tool: 'mule-build',
                    toolVersion: '3.2.0',
                    stripped: !productionDeployable,
                    productionDeployable,
                }),
            );
        const writeJar = (productionDeployable?: boolean) =>
            writeFileSync(
                jarPath,
                zipSync({
                    'META-INF/maven/dev.sample/sample/pom.properties': strToU8(
                        'groupId=dev.sample\nartifactId=sample\nversion=2.4.1\n',
                    ),
                    ...(productionDeployable === undefined
                        ? {}
                        : { 'META-INF/mule-build/build-info.json': marker(productionDeployable) }),
                }),
            );
        const input = { appName: 'sample', environment: 'Production' };
        afterEach(() =>
            client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'sample-env', name: 'Test' }),
        );

        it.each(['deploy_jar', 'publish_app_jar'])(
            'refuses a stripped jar for production in %s preview and commit',
            async (name) => {
                writeJar(false);
                client.accessManagement.resolveEnvironment.mockResolvedValue(production);
                for (const extra of [{}, { confirm: true, confirmProduction: true }]) {
                    const result = await handlers.get(name)!({ ...input, jarPath, ...extra });
                    const body = JSON.parse(result.content[0].text);
                    expect(result.isError).toBe(true);
                    expect(body.refused).toBe(true);
                    expect(body.message).toContain('cannot go to a production environment');
                    expect(body.buildProvenance).toMatchObject({ status: 'recorded', productionDeployable: false });
                }
                expect(client.exchange.publishAppAsset).not.toHaveBeenCalled();
                expect(client.cloudHub2.createDeployment).not.toHaveBeenCalled();
            },
        );

        it('warns about a stripped jar outside production and still deploys on confirm', async () => {
            writeJar(false);
            const preview = JSON.parse(
                (await handlers.get('deploy_jar')!({ ...input, jarPath, environment: 'Test' })).content[0].text,
            );
            expect(preview.dryRun).toBe(true);
            expect(preview.provenanceWarnings[0]).toContain('not production deployable');
            const result = await handlers.get('deploy_jar')!({ ...input, jarPath, environment: 'Test', confirm: true });
            expect(result.isError).not.toBe(true);
            expect(client.cloudHub2.createDeployment).toHaveBeenCalled();
        });

        it('refuses an unmarked jar for production unless an allowance covers the org and environment', async () => {
            writeJar(undefined);
            client.accessManagement.resolveEnvironment.mockResolvedValue(production);
            const refused = JSON.parse((await handlers.get('deploy_jar')!({ ...input, jarPath })).content[0].text);
            expect(refused.refused).toBe(true);
            expect(refused.message).toContain('build provenance unknown');
            expect(refused.provenancePolicy).toEqual({ unmarkedAllowed: false });

            const scope = { orgId: 'sample-org', environmentId: production.id };
            saveUnmarkedAllowance(scope, scope);
            try {
                const body = JSON.parse((await handlers.get('deploy_jar')!({ ...input, jarPath })).content[0].text);
                expect(body.dryRun).toBe(true);
                expect(body.buildProvenance.note).toContain('build provenance unknown');
                expect(body.provenancePolicy).toMatchObject({ unmarkedAllowed: true });
            } finally {
                saveUnmarkedAllowance(scope, null);
            }
        });

        it('lets a production-deployable jar through', async () => {
            writeJar(true);
            client.accessManagement.resolveEnvironment.mockResolvedValue(production);
            const body = JSON.parse((await handlers.get('deploy_jar')!({ ...input, jarPath })).content[0].text);
            expect(body).toMatchObject({ dryRun: true, production: true, productionPreapproved: false });
            expect(body.blockers).toBeUndefined();
        });

        it('publish_app_jar without an environment only warns', async () => {
            writeJar(false);
            const body = JSON.parse((await handlers.get('publish_app_jar')!({ jarPath })).content[0].text);
            expect(body.dryRun).toBe(true);
            expect(body.warnings[0]).toContain('not production deployable');
        });
    });

    it('requires explicit coordinates when embedded metadata is missing', async () => {
        writeFileSync(jarPath, zipSync({ 'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\n') }));
        const handler = handlers.get('publish_app_jar')!;
        expect((await handler({ jarPath })).isError).toBe(true);
        const result = await handler({ jarPath, assetId: 'sample', assetVersion: '2.4.1' });
        expect(JSON.parse(result.content[0].text).coordinates.assetId).toBe('sample');
    });
});
