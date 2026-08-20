import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignCenterWorkflow } from '../../src/api/DesignCenterWorkflow.js';

describe('DesignCenterWorkflow', () => {
    let files: Map<string, string>;
    let designCenter: any;
    let exchange: any;
    let workflow: DesignCenterWorkflow;

    beforeEach(() => {
        files = new Map([
            ['api.raml', '#%RAML 1.0\ntitle: Inventory'],
            ['unchanged.json', '{"ok":true}'],
        ]);
        designCenter = {
            getProjects: vi.fn().mockResolvedValue([]),
            createProject: vi.fn().mockResolvedValue({ id: 'p-1', name: 'neutral-api', type: 'raml' }),
            findByNameOrThrow: vi.fn().mockResolvedValue({ id: 'p-1', name: 'neutral-api' }),
            getFiles: vi.fn().mockImplementation(async () => [...files.keys()].map((path) => ({ path, type: 'FILE' }))),
            getFileContent: vi.fn().mockImplementation(async (_org: string, _project: string, path: string) => {
                const value = files.get(path);
                if (value === undefined) throw new Error('missing');
                return value;
            }),
            maintainLock: vi.fn().mockResolvedValue(undefined),
            withLock: vi
                .fn()
                .mockImplementation(
                    async (_org: string, _project: string, _branch: string, operation: () => Promise<unknown>) =>
                        operation(),
                ),
            saveFiles: vi
                .fn()
                .mockImplementation(
                    async (_org: string, _project: string, changed: Array<{ path: string; content: string }>) => {
                        for (const file of changed) files.set(file.path, file.content);
                    },
                ),
            getExchangeJson: vi.fn().mockResolvedValue(null),
            publishToExchangeLocked: vi
                .fn()
                .mockResolvedValue({ groupId: 'org-1', assetId: 'neutral-api', version: '1.0.0' }),
        };
        exchange = {
            downloadSpecArtifact: vi.fn().mockResolvedValue({ sha256: 'artifact-hash', metadataHashMatches: true }),
        };
        workflow = new DesignCenterWorkflow(designCenter, exchange);
    });

    it('uses single-use tokens and rechecks creation through the API', async () => {
        const preview = await workflow.previewProjectCreate('org-1', 'neutral-api', 'raml');
        await expect(workflow.createProject(preview.previewToken)).resolves.toMatchObject({ id: 'p-1' });
        await expect(workflow.createProject(preview.previewToken)).rejects.toThrow(/invalid or already used/);
    });

    it('previews and applies one conflict-safe batch without deletes', async () => {
        const preview = await workflow.previewSync(
            'org-1',
            'neutral-api',
            [
                { path: 'api.raml', content: '#%RAML 1.0\ntitle: Inventory v2' },
                { path: 'unchanged.json', content: '{"ok":true}' },
                { path: 'types/item.raml', content: '#%RAML 1.0 DataType\ntype: string' },
            ],
            'master',
        );
        expect(preview.entries.map((entry) => entry.action)).toEqual(['update', 'unchanged', 'create']);
        const result = await workflow.sync(preview.previewToken);
        expect(result.changed).toBe(2);
        expect(designCenter.saveFiles).toHaveBeenCalledTimes(1);
        expect(designCenter.saveFiles.mock.calls[0][2]).toHaveLength(2);
        expect(designCenter.maintainLock).toHaveBeenCalledTimes(1);
    });

    it('atomically aborts when a remote file changes after preview', async () => {
        const preview = await workflow.previewSync('org-1', 'neutral-api', [
            { path: 'api.raml', content: '#%RAML 1.0\ntitle: Intended' },
        ]);
        files.set('api.raml', '#%RAML 1.0\ntitle: Concurrent edit');
        await expect(workflow.sync(preview.previewToken)).rejects.toThrow(/changed after preview/);
        expect(designCenter.saveFiles).not.toHaveBeenCalled();
    });

    it('rejects traversal and managed dependency paths before issuing a preview', async () => {
        await expect(
            workflow.previewSync('org-1', 'neutral-api', [{ path: '../api.raml', content: 'x' }]),
        ).rejects.toThrow(/Unsafe/);
        await expect(
            workflow.previewSync('org-1', 'neutral-api', [{ path: 'exchange_modules/dependency.raml', content: 'x' }]),
        ).rejects.toThrow(/exchange_modules/);
    });

    it('binds publication to the previewed source and verifies the Exchange artifact', async () => {
        const options = {
            name: 'Neutral API',
            apiVersion: 'v1',
            version: '1.0.0',
            classifier: 'raml',
            main: 'api.raml',
            groupId: 'org-1',
            assetId: 'neutral-api',
        };
        const preview = await workflow.previewPublication('org-1', 'neutral-api', options);
        const result = await workflow.publish(preview.previewToken);
        expect(result.verified).toBe(true);
        expect(designCenter.withLock).toHaveBeenCalled();
        expect(designCenter.publishToExchangeLocked).toHaveBeenCalled();
        expect(exchange.downloadSpecArtifact).toHaveBeenCalledWith('org-1', 'neutral-api', '1.0.0');

        const driftPreview = await workflow.previewPublication('org-1', 'neutral-api', options);
        files.set('api.raml', 'changed after approval');
        await expect(workflow.publish(driftPreview.previewToken)).rejects.toThrow(/changed after publication preview/);
    });
});
