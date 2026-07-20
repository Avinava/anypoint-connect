/**
 * Tests for ExchangeApi
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExchangeApi } from '../../src/api/ExchangeApi.js';
import { Cache } from '../../src/client/Cache.js';

const mockGet = vi.fn();
const mockPostMultipart = vi.fn();
const mockDownload = vi.fn();
const mockHttp = { get: mockGet, postMultipart: mockPostMultipart, download: mockDownload } as any;

describe('ExchangeApi.publishAppAsset', () => {
    let api: ExchangeApi;
    let jarPath: string;

    beforeEach(() => {
        vi.resetAllMocks();
        api = new ExchangeApi(mockHttp, new Cache());
        jarPath = path.join(os.tmpdir(), `anc-test-${process.pid}.jar`);
        fs.writeFileSync(jarPath, Buffer.from('PK fake jar bytes'));
    });

    afterEach(() => {
        if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
    });

    it('POSTs multipart to the v2 publication endpoint with the sync header and a timeout', async () => {
        mockPostMultipart.mockResolvedValue({});

        const result = await api.publishAppAsset('org-1', 'grp-1', 'my-app', '1.0.0', jarPath);

        expect(mockPostMultipart).toHaveBeenCalledWith(
            '/exchange/api/v2/organizations/org-1/assets/grp-1/my-app/1.0.0',
            expect.any(FormData),
            expect.objectContaining({
                headers: expect.objectContaining({ 'x-sync-publication': 'true' }),
                timeout: expect.any(Number),
            }),
        );
        expect(result).toEqual({
            groupId: 'grp-1',
            assetId: 'my-app',
            version: '1.0.0',
            classifier: 'mule-application',
            fileName: path.basename(jarPath),
        });
    });

    it('builds a multipart body with name, classifier, and the jar file part', async () => {
        mockPostMultipart.mockResolvedValue({});
        await api.publishAppAsset('org-1', 'grp-1', 'my-app', '1.0.0', jarPath);

        const form: FormData = mockPostMultipart.mock.calls[0][1];
        expect(form.get('name')).toBe('my-app');
        expect(form.get('classifier')).toBe('mule-application');
        expect(form.get('files.mule-application.jar')).toBeInstanceOf(Blob);
    });
});
